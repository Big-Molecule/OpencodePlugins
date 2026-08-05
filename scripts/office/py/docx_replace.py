#!/usr/bin/env python3
"""Find/replace plain text across paragraph runs in a DOCX."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def replace_in_paragraph(para, old: str, new: str) -> int:
    # Simple approach: join run texts, replace, write back to first run
    full = "".join(r.text or "" for r in para.runs)
    if old not in full and old not in (para.text or ""):
        # also check para.text which includes hyperlink etc.
        text = para.text or ""
        if old not in text:
            return 0
        count = text.count(old)
        # clear and rewrite
        for r in para.runs:
            r.text = ""
        if para.runs:
            para.runs[0].text = text.replace(old, new)
        else:
            para.add_run(text.replace(old, new))
        return count
    count = full.count(old)
    if count == 0:
        return 0
    replaced = full.replace(old, new)
    if para.runs:
        para.runs[0].text = replaced
        for r in para.runs[1:]:
            r.text = ""
    else:
        para.add_run(replaced)
    return count


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("docx")
    p.add_argument("--old", required=True)
    p.add_argument("--new", required=True)
    p.add_argument("--out", default="")
    args = p.parse_args()

    path = Path(args.docx)
    if not path.is_file():
        print(json.dumps({"ok": False, "error": f"not found: {path}"}))
        return 1

    from docx import Document

    doc = Document(str(path))
    total = 0
    for para in doc.paragraphs:
        total += replace_in_paragraph(para, args.old, args.new)
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                for para in cell.paragraphs:
                    total += replace_in_paragraph(para, args.old, args.new)

    out = Path(args.out) if args.out.strip() else path
    out.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out))
    print(json.dumps({"ok": True, "path": str(out.resolve()), "replacements": total}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
