#!/usr/bin/env python3
"""Extract text from PDF pages (pypdf)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("pdf")
    p.add_argument("--page", type=int, default=0, help="1-based page; 0=all")
    p.add_argument("--max-chars", type=int, default=8000)
    args = p.parse_args()

    path = Path(args.pdf)
    if not path.is_file():
        print(json.dumps({"ok": False, "error": f"not found: {path}"}))
        return 1

    try:
        from pypdf import PdfReader
    except ImportError:
        print(json.dumps({"ok": False, "error": "pypdf not installed; run office_setup again"}))
        return 1

    reader = PdfReader(str(path))
    n = len(reader.pages)
    pages = []
    if args.page and args.page > 0:
        if args.page > n:
            print(json.dumps({"ok": False, "error": f"page {args.page} out of range 1..{n}"}))
            return 1
        idxs = [args.page - 1]
    else:
        idxs = list(range(n))

    for i in idxs:
        text = reader.pages[i].extract_text() or ""
        pages.append({"page": i + 1, "text": text[: args.max_chars], "len": len(text)})

    print(json.dumps({"ok": True, "path": str(path.resolve()), "page_count": n, "pages": pages}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
