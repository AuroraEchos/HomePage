#!/usr/bin/env python3
"""Validate posts/*.md metadata and generate assets/js/notes-data.js.

Usage (from the repository root):
    python3 tools/build_notes.py
    python3 tools/build_notes.py --check
"""

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
POSTS_DIR = ROOT / "posts"
OUT_PATH = ROOT / "assets" / "js" / "notes-data.js"

CATEGORY_LABELS = {
    "agent": "Agent",
    "other": "Other",
}
VALID_CATEGORIES = set(CATEGORY_LABELS)
VALID_FIELDS = {"id", "date", "category", "title"}
ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")

FRONT_MATTER_RE = re.compile(r"\A(?:\uFEFF)?---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.DOTALL)
H1_RE = re.compile(r"^#[ \t]+(.+?)[ \t]*$", re.MULTILINE)
FENCE_RE = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})")
MARKDOWN_IMAGE_RE = re.compile(r"!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))")
HTML_IMAGE_RE = re.compile(r"<img\b[^>]*\bsrc=[\"']([^\"']+)[\"']", re.IGNORECASE)


def strip_inline_comment(value):
    """Strip a YAML-style comment while preserving quoted text and words like C#."""
    quote = None
    escaped = False
    for index, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if char == "\\" and quote == '"':
            escaped = True
            continue
        if char in "\"'":
            if quote is None:
                quote = char
            elif quote == char:
                quote = None
            continue
        if char == "#" and quote is None and (index == 0 or value[index - 1].isspace()):
            return value[:index].rstrip()
    return value.rstrip()


def parse_front_matter(text, filename="<text>"):
    """Return ``(fields, body, errors)`` for the supported metadata subset."""
    match = FRONT_MATTER_RE.match(text)
    if not match:
        return None, text, [f"{filename}: 缺少有效的 front-matter"]

    fields = {}
    errors = []
    for line_number, raw_line in enumerate(match.group(1).splitlines(), start=2):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition(":")
        key = key.strip().lower()
        if not separator or not key:
            errors.append(f"{filename}:{line_number}: 元数据必须使用 key: value 格式")
            continue
        if key not in VALID_FIELDS:
            errors.append(f"{filename}:{line_number}: 未知字段 {key!r}")
            continue
        if key in fields:
            errors.append(f"{filename}:{line_number}: 字段 {key!r} 重复")
            continue

        value = strip_inline_comment(value.strip())
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        fields[key] = value

    return fields, text[match.end():], errors


def heading_title(body):
    match = H1_RE.search(body)
    return match.group(1).strip() if match else None


def validate_date(value):
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return parsed.strftime("%Y-%m-%d") == value


def validate_body(path, body):
    """Check inexpensive content invariants that commonly break the reader."""
    errors = []
    open_fence = None
    open_line = None
    for line_number, line in enumerate(body.splitlines(), start=1):
        match = FENCE_RE.match(line)
        if not match:
            continue
        fence = match.group(1)
        if open_fence is None:
            open_fence = fence
            open_line = line_number
        elif fence[0] == open_fence[0] and len(fence) >= len(open_fence):
            open_fence = None
            open_line = None
    if open_fence is not None:
        errors.append(f"{path.name}: 正文第 {open_line} 行的代码围栏未闭合")

    image_sources = [match.group(1) or match.group(2) for match in MARKDOWN_IMAGE_RE.finditer(body)]
    image_sources.extend(match.group(1) for match in HTML_IMAGE_RE.finditer(body))
    for source in image_sources:
        parsed = urlsplit(source)
        if parsed.scheme or parsed.netloc or parsed.path.startswith(("/", "#")):
            continue
        relative_path = unquote(parsed.path)
        resolved = (path.parent / relative_path).resolve()
        try:
            resolved.relative_to(ROOT)
        except ValueError:
            errors.append(f"{path.name}: 本地图片超出仓库范围: {source}")
            continue
        if not resolved.is_file():
            errors.append(f"{path.name}: 找不到本地图片: {source}")
    return errors


def collect_notes():
    notes = []
    errors = []
    seen_ids = {}
    paths = sorted(POSTS_DIR.glob("*.md"))
    if not paths:
        errors.append("posts/: 没有找到 Markdown 笔记")

    for path in paths:
        text = path.read_text(encoding="utf-8")
        fields, body, parse_errors = parse_front_matter(text, path.name)
        errors.extend(parse_errors)
        if fields is None:
            continue

        errors.extend(validate_body(path, body))

        note_id = fields.get("id", "")
        if not ID_RE.fullmatch(note_id):
            errors.append(f"{path.name}: id 必须是由小写字母、数字和单个连字符组成的短标识")
        elif note_id in seen_ids:
            errors.append(f"{path.name}: id {note_id!r} 与 {seen_ids[note_id]} 重复")
        else:
            seen_ids[note_id] = path.name

        date = fields.get("date", "")
        if not validate_date(date):
            errors.append(f"{path.name}: date 必须是真实的 YYYY-MM-DD 日期")

        category = fields.get("category", "other")
        if category not in VALID_CATEGORIES:
            choices = " | ".join(CATEGORY_LABELS)
            errors.append(f"{path.name}: category 必须是 {choices} 之一")

        title = fields.get("title") or heading_title(body)
        if not title or not title.strip():
            errors.append(f"{path.name}: title 缺失且正文没有一级标题")

        if ID_RE.fullmatch(note_id) and validate_date(date) and category in VALID_CATEGORIES and title and title.strip():
            notes.append({
                "id": note_id,
                "date": date.replace("-", "."),
                "category": category,
                "title": title,
                "path": f"posts/{path.name}",
            })

    notes.sort(key=lambda note: (note["date"], note["title"]), reverse=True)
    return notes, errors


def render_catalog(notes):
    payload = {"categoryLabels": CATEGORY_LABELS, "notes": notes}
    return "\n".join([
        "// 此文件由 tools/build_notes.py 自动生成，请勿手动编辑。",
        "// 修改 posts/ 下的 front-matter 后运行：python3 tools/build_notes.py",
        f"window.noteCatalog = {json.dumps(payload, ensure_ascii=False, indent=2)};",
        "",
    ])


def main():
    parser = argparse.ArgumentParser(description="校验笔记元数据并生成列表数据")
    parser.add_argument("--check", action="store_true", help="只检查生成文件是否为最新，不写入文件")
    args = parser.parse_args()

    notes, errors = collect_notes()
    if errors:
        for error in errors:
            print(f"错误: {error}", file=sys.stderr)
        print(f"校验失败：共 {len(errors)} 个错误", file=sys.stderr)
        return 1

    generated = render_catalog(notes)
    if args.check:
        current = OUT_PATH.read_text(encoding="utf-8") if OUT_PATH.exists() else ""
        if current != generated:
            print(f"错误: {OUT_PATH.relative_to(ROOT)} 不是最新，请运行 python3 tools/build_notes.py", file=sys.stderr)
            return 1
        print(f"检查通过：{len(notes)} 篇笔记，生成文件为最新")
        return 0

    temporary = OUT_PATH.with_suffix(f"{OUT_PATH.suffix}.tmp")
    temporary.write_text(generated, encoding="utf-8")
    temporary.replace(OUT_PATH)
    print(f"已生成 {OUT_PATH.relative_to(ROOT)}：{len(notes)} 篇笔记")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
