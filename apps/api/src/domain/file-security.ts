import { extname } from 'node:path';
import type { DocumentType } from '@competition/contracts';
import { AppException } from '../platform/app-exception';

const EXTENSION_TYPE: Record<string, DocumentType> = {
  '.pdf': 'pdf',
  '.doc': 'word',
  '.docx': 'word',
  '.xls': 'excel',
  '.xlsx': 'excel',
  '.csv': 'csv',
  '.txt': 'text',
  '.md': 'text',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
};

const MAGIC: Array<{ type: DocumentType; bytes: number[] }> = [
  { type: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { type: 'excel', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { type: 'image', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: 'image', bytes: [0xff, 0xd8, 0xff] },
];

const ZIP_CONTAINERS: DocumentType[] = ['word', 'excel'];

export function decodeMultipartFilename(name: string): string {
  // Multer 默认将 multipart 文件名参数按 Latin-1 读取。
  if (!/[\u0080-\u00ff]/.test(name) || /[^\u0000-\u00ff]/.test(name)) return name;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(name, 'latin1'));
  } catch {
    return name;
  }
}

export function detectDocumentType(fileName: string, buffer: Buffer): { type: DocumentType; accepted: boolean; reason?: string; reasonCode?: string } {
  const ext = extname(fileName).toLowerCase();
  const declared = EXTENSION_TYPE[ext] ?? 'unknown';
  if (declared === 'unknown') {
    return { type: 'unknown', accepted: false, reason: '不支持该文件扩展名', reasonCode: 'FILE_FORMAT_UNSUPPORTED' };
  }

  const matchesMagic = MAGIC.some(
    (entry) => entry.bytes.every((byte, index) => buffer[index] === byte),
  );

  if (declared === 'pdf') {
    if (!matchesMagic) {
      return {
        type: 'pdf',
        accepted: false,
        reason: '文件头与 PDF 格式不符，可能被伪装',
        reasonCode: 'FILE_SECURITY_REJECTED',
      };
    }
    if (/\/JavaScript|\/OpenAction|\/Encrypt/.test(buffer.subarray(0, 4096).toString('latin1'))) {
      return {
        type: 'pdf',
        accepted: false,
        reason: 'PDF 包含脚本或加密内容，已拒绝',
        reasonCode: 'FILE_SECURITY_REJECTED',
      };
    }
  }

  if (declared === 'image') {
    const known = MAGIC.filter((entry) => entry.type === 'image').some((entry) =>
      entry.bytes.every((byte, index) => buffer[index] === byte),
    );
    if (!known) {
      return {
        type: 'image',
        accepted: false,
        reason: '图片文件头无法识别',
        reasonCode: 'FILE_SECURITY_REJECTED',
      };
    }
  }

  if (ZIP_CONTAINERS.includes(declared)) {
    const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
    if (!isZip) {
      return {
        type: declared,
        accepted: false,
        reason: 'OOXML 结构校验失败',
        reasonCode: 'FILE_SECURITY_REJECTED',
      };
    }
    const uncompressedRatio = estimateCompressionRatio(buffer);
    if (uncompressedRatio > 100) {
      return {
        type: declared,
        accepted: false,
        reason: '压缩比异常，疑似压缩炸弹',
        reasonCode: 'FILE_SECURITY_REJECTED',
      };
    }
  }

  if (!matchesMagic && !['text', 'csv'].includes(declared) && !['word', 'excel'].includes(declared) && declared !== 'image') {
    return {
      type: declared,
      accepted: false,
      reason: '文件真实类型无法校验',
      reasonCode: 'FILE_UNREADABLE',
    };
  }

  return { type: declared, accepted: true };
}

function estimateCompressionRatio(buffer: Buffer): number {
  for (let index = 0; index < buffer.length - 26; index += 1) {
    if (buffer[index] === 0x50 && buffer[index + 1] === 0x4b && buffer[index + 2] === 0x01 && buffer[index + 3] === 0x02) {
      const compressed = buffer.readUInt32LE(index + 20);
      const uncompressed = buffer.readUInt32LE(index + 24);
      if (compressed > 0) return uncompressed / compressed;
    }
  }
  return 1;
}

export function assertFileLimits(files: Array<{ size: number }>, maxSingle: number, maxTotal: number): void {
  if (files.length > 10) {
    throw new AppException('FILE_LIMIT_EXCEEDED', { files: files.length, limit: 10 });
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > maxTotal) {
    throw new AppException('FILE_LIMIT_EXCEEDED', { total, limit: maxTotal });
  }
  for (const file of files) {
    if (file.size > maxSingle) {
      throw new AppException('FILE_SIZE_EXCEEDED', { size: file.size, limit: maxSingle });
    }
  }
}
