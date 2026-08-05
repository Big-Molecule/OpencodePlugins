#!/usr/bin/env python3
"""Set page margins (inches) and orientation for all sections."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("docx")
    p.add_argument("--top", type=float, default=None)
    p.add_argument("--bottom", type=float, default=None)
    p.add_argument("--left", type=float, default=None)
    p.add_argument("--right", type=float, default=None)
    p.add_argument("--orientation", choices=["portrait", "landscape", ""], default="")
    p.add_argument("--out", default="")
    args = p.parse_args()

    path = Path(args.docx)
    if not path.is_file():
        print(json.dumps({"ok": False, "error": f"not found: {path}"}))
        return 1

    from docx import Document
    from docx.enum.section import WD_ORIENT
    from docx.shared import Inches

    doc = Document(str(path))
    for section in doc.sections:
        if args.top is not None:
            section.top_margin = Inches(args.top)
        if args.bottom is not None:
            section.bottom_margin = Inches(args.bottom)
        if args.left is not None:
            section.left_margin = Inches(args.left)
        if args.right is not None:
            section.right_margin = Inches(args.right)
        if args.orientation == "landscape":
            section.orientation = WD_ORIENT.LANDSCAPE
            # swap width/height if needed
            if section.page_width < section.page_height:
                section.page_width, section.page_height = section.page_height, section.page_width
        elif args.orientation == "portrait":
            section.orientation = WD_ORIENT.PORTRAIT
            if section.page_width > section.page_height:
                section.page_width, section.page_height = section.page_height, section.page_width

    out = Path(args.out) if args.out.strip() else path
    out.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out))
    print(json.dumps({"ok": True, "path": str(out.resolve())}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
