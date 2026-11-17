import base64
import io
import re
import zipfile

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="competition-parser", version="0.1.0")

MAX_BYTES = 20 * 1024 * 1024
MAX_TEXT = 2_000_000


class ParseRequest(BaseModel):
    fileName: str
    declaredType: str | None = None
    contentBase64: str
    extractTables: bool = False


def detect_type(file_name: str, data: bytes) -> str:
    lower = file_name.lower()
    if lower.endswith(".pdf") or data[:4] == b"%PDF":
        return "pdf"
    if lower.endswith((".docx", ".doc")):
        return "word"
    if lower.endswith((".xlsx", ".xls")):
        return "excel"
    if lower.endswith(".csv"):
        return "csv"
    if lower.endswith((".txt", ".md")):
        return "text"
    if lower.endswith((".png", ".jpg", ".jpeg")):
        return "image"
    return "unknown"


def block(text: str, location: dict) -> dict:
    return {"text": text, "location": location}


def pdf_table_rows(table) -> list[list[str | None]]:
    rows = table.extract()
    if not rows:
        return rows
    cells = [row.cells for row in table.rows]
    columns = cells[0]
    for row_index, row in enumerate(rows[1:], 1):
        bounds = [cell for cell in cells[row_index] if cell is not None]
        if not bounds:
            continue
        top = max(cell[1] for cell in bounds)
        bottom = min(cell[3] for cell in bounds)
        if bottom <= top:
            continue
        y = (top + bottom) / 2
        for index, column in enumerate(columns):
            if column is None or row[index] is not None:
                continue
            x = (column[0] + column[2]) / 2
            for prior in range(row_index - 1, 0, -1):
                span = cells[prior][index]
                if span is not None and span[0] < x < span[2] and span[1] < y < span[3]:
                    row[index] = rows[prior][index]
                    break
    return rows


def parse_pdf(data: bytes, extract_tables: bool = False) -> tuple[str, list[dict], int, list[list[list[str | None]]]]:
    try:
        import fitz  # type: ignore
    except ImportError as exc:
        raise HTTPException(status_code=422, detail={"errorCode": "FILE_UNREADABLE", "message": "服务端缺少 PyMuPDF"}) from exc

    doc = fitz.open(stream=data, filetype="pdf")
    if doc.is_encrypted:
        raise HTTPException(status_code=422, detail={"errorCode": "FILE_SECURITY_REJECTED", "message": "PDF 已加密，无法解析"})

    page_count = doc.page_count
    if page_count > 400:
        raise HTTPException(status_code=422, detail={"errorCode": "FILE_SECURITY_REJECTED", "message": "PDF 页数超过 400 页限制"})

    blocks: list[dict] = []
    lines: list[str] = []
    tables: list[list[list[str | None]]] = []
    for page_index in range(page_count):
        page = doc.load_page(page_index)
        text = page.get_text("text") or ""
        if extract_tables and re.search(r"赛题|科目|项目", text) and hasattr(page, "find_tables"):
            tables.extend(pdf_table_rows(table) for table in page.find_tables().tables)
        for line_index, line in enumerate((item for item in text.splitlines() if item.strip())):
            stripped = line.strip()
            lines.append(stripped)
            blocks.append(
                block(
                    stripped,
                    {
                        "kind": "pdf",
                        "page": page_index + 1,
                        "line": line_index + 1,
                        "bbox": None,
                    },
                )
            )
    return "\n".join(lines), blocks, page_count, tables


def parse_docx(data: bytes) -> tuple[str, list[dict], int]:
    try:
        from docx import Document  # type: ignore
    except ImportError as exc:
        raise HTTPException(status_code=422, detail={"errorCode": "FILE_UNREADABLE", "message": "服务端缺少 python-docx"}) from exc

    document = Document(io.BytesIO(data))
    lines = [paragraph.text.strip() for paragraph in document.paragraphs if paragraph.text.strip()]
    blocks = [
        block(line, {"kind": "word", "paragraph": index + 1})
        for index, line in enumerate(lines)
    ]
    for table_index, table in enumerate(document.tables):
        for row_index, row in enumerate(table.rows):
            joined = " | ".join(cell.text.strip() for cell in row.cells)
            if joined.strip():
                lines.append(joined)
                blocks.append(
                    block(joined, {"kind": "word", "table": table_index + 1, "row": row_index + 1})
                )
    return "\n".join(lines), blocks, 1


def parse_xlsx(data: bytes) -> tuple[str, list[dict], int]:
    try:
        from openpyxl import load_workbook  # type: ignore
    except ImportError as exc:
        raise HTTPException(status_code=422, detail={"errorCode": "FILE_UNREADABLE", "message": "服务端缺少 openpyxl"}) from exc

    workbook = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    lines: list[str] = []
    blocks: list[dict] = []
    for sheet in workbook.worksheets:
        for row_index, row in enumerate(sheet.iter_rows(values_only=True), start=1):
            if row_index > 5000:
                break
            values = ["" if value is None else str(value) for value in row]
            joined = " | ".join(values).strip()
            if joined:
                lines.append(joined)
                blocks.append(
                    block(joined, {"kind": "excel", "sheet": sheet.title, "row": row_index})
                )
    return "\n".join(lines), blocks, len(workbook.worksheets)


def parse_text(data: bytes) -> tuple[str, list[dict], int]:
    text = data.decode("utf-8", errors="replace").lstrip("\ufeff")
    lines = text.splitlines()
    blocks = [
        block(line, {"kind": "text", "line": index + 1})
        for index, line in enumerate(lines)
        if line.strip()
    ]
    return text, blocks, 1


def parse_zip_inspection(data: bytes) -> None:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            total = sum(info.file_size for info in archive.infolist())
            if total > 200 * 1024 * 1024:
                raise HTTPException(
                    status_code=422,
                    detail={"errorCode": "FILE_SECURITY_REJECTED", "message": "解压后体积超过限制"},
                )
    except zipfile.BadZipFile as exc:
        raise HTTPException(
            status_code=422,
            detail={"errorCode": "FILE_SECURITY_REJECTED", "message": "OOXML 结构损坏"},
        ) from exc


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.get("/readyz")
def readyz() -> dict:
    return {"status": "ok", "dependencies": {"parser": "ready"}}


@app.post("/v1/parse")
def parse(request: ParseRequest) -> dict:
    try:
        data = base64.b64decode(request.contentBase64, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400,
            detail={"errorCode": "VALIDATION_FAILED", "message": "文件内容无法解码"},
        ) from exc

    if len(data) > MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail={"errorCode": "FILE_SIZE_EXCEEDED", "message": "文件超过 20MB 限制"},
        )

    file_type = detect_type(request.fileName, data)

    tables: list[list[list[str | None]]] = []
    try:
        if file_type == "pdf":
            text, blocks, page_count, tables = parse_pdf(data, request.extractTables)
        elif file_type == "word":
            parse_zip_inspection(data)
            text, blocks, page_count = parse_docx(data)
        elif file_type == "excel":
            parse_zip_inspection(data)
            text, blocks, page_count = parse_xlsx(data)
        elif file_type in {"csv", "text"}:
            text, blocks, page_count = parse_text(data)
        elif file_type == "image":
            text, blocks, page_count = "", [], 1
        else:
            raise HTTPException(
                status_code=415,
                detail={"errorCode": "FILE_FORMAT_UNSUPPORTED", "message": "不支持的文件格式"},
            )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=422,
            detail={"errorCode": "FILE_UNREADABLE", "message": f"解析失败：{type(exc).__name__}"},
        ) from exc

    truncated = len(text) > MAX_TEXT
    return {
        "ok": True,
        "text": text[:MAX_TEXT],
        "blocks": blocks,
        "pageCount": page_count,
        "truncated": truncated,
        "detectedType": file_type,
        "source": "python",
        **({"tables": tables} if request.extractTables else {}),
    }


@app.post("/v1/security/check")
def security_check(request: ParseRequest) -> dict:
    data = base64.b64decode(request.contentBase64)
    findings: list[str] = []
    if re.search(rb"\/JavaScript|\/OpenAction|\/Encrypt", data[:4096]):
        findings.append("pdf_active_content")
    if data[:2] == b"PK" and len(data) > 0:
        findings.append("zip_container_checked")
    return {"ok": not findings or findings == ["zip_container_checked"], "findings": findings}
