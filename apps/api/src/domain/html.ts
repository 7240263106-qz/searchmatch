export interface LinkItem {
  url: string;
  text: string;
  index: number;
}

export function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&ldquo;/gi, '“')
    .replace(/&rdquo;/gi, '”')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&rsquo;/gi, '’')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCharCode(parseInt(code, 16)));
}

export function htmlToText(html: string): string {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|br|hr)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/\u3000/g, ' ');
  text = text.replace(/[ \t]+/g, ' ');
  text = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
  return text;
}

export function extractLinks(html: string, baseUrl: string, options: { hashRoutes?: boolean } = {}): LinkItem[] {
  const links: LinkItem[] = [];
  const seen = new Set<string>();
  const pattern = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match = pattern.exec(html);
  let index = 0;

  while (match) {
    const rawHref = match[1]?.trim() ?? '';
    const rawText = match[2] ?? '';
    index += 1;

    if (!rawHref || (rawHref.startsWith('#') && !(options.hashRoutes && rawHref.startsWith('#/'))) ||
      /^(javascript|mailto|tel):/i.test(rawHref)) {
      match = pattern.exec(html);
      continue;
    }

    let absolute: string;
    try {
      absolute = new URL(decodeEntities(rawHref), baseUrl).toString();
    } catch {
      match = pattern.exec(html);
      continue;
    }

    const text = htmlToText(rawText).replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!seen.has(absolute)) {
      seen.add(absolute);
      links.push({ url: absolute, text, index });
    }
    match = pattern.exec(html);
  }

  return links;
}

const ATTACHMENT_PATTERN = /\.(pdf|docx?|xlsx?|xls|csv|zip|rar)(\?|#|$)/i;

export function findAttachmentLinks(html: string, baseUrl: string): LinkItem[] {
  const links = extractLinks(html, baseUrl);
  return links.filter(
    (link) =>
      ATTACHMENT_PATTERN.test(link.url) ||
      /(附件|下载|报名表|参赛手册|竞赛规程|通知附件|报名文档)/.test(link.text),
  );
}

export function pageTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match?.[1]) return null;
  return decodeEntities(match[1].replace(/\s+/g, ' ').trim()).slice(0, 160);
}
