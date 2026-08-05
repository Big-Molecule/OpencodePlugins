#!/usr/bin/env python3
"""Print DOCX structure/text summary as JSON lines for the agent."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("docx")
    p.add_argument("--max-paras", type=int, default=80)
    p.add_argument("--max-chars", type=int, default=200)
    args = p.parse_args()

    path = Path(args.docx)
    if not path.is_file():
        print(json.dumps({"ok": False, "error": f"not found: {path}"}))
        return 1

    from docx import Document

    doc = Document(str(path))
    paras = []
    for i, para in enumerate(doc.paragraphs):
        text = (para.text or "").strip()
        if not text:
            continue
        style = para.style.name if para.style is not None else ""
        paras.append(
            {
                "index": i,
                "style": style,
                "text": text[: args.max_chars],
                "len": len(text),
            }
        )
        if len(paras) >= args.max_paras:
            break

    tables = []
    for ti, table in enumerate(doc.tables):
        rows = len(table.rows)
        cols = len(table.columns) if table.rows else 0
        preview = []
        for r in table.rows[:3]:
            preview.append([c.text.strip()[:40] for c in r.cells[:6]])
        tables.append({"index": ti, "rows": rows, "cols": cols, "preview": preview})

    out = {
        "ok": True,
        "path": str(path.resolve()),
        "paragraphs_total": len(doc.paragraphs),
        "paragraphs": paras,
        "tables": tables,
        "sections": len(doc.sections),
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
