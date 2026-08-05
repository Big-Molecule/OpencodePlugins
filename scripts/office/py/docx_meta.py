#!/usr/bin/env python3
"""Read or scrub core document properties."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("docx")
    p.add_argument("--action", choices=["get", "scrub"], default="get")
    p.add_argument("--out", default="")
    args = p.parse_args()

    path = Path(args.docx)
    if not path.is_file():
        print(json.dumps({"ok": False, "error": f"not found: {path}"}))
        return 1

    from docx import Document

    doc = Document(str(path))
    props = doc.core_properties

    if args.action == "get":
        print(
            json.dumps(
                {
                    "ok": True,
                    "author": props.author,
                    "last_modified_by": props.last_modified_by,
                    "title": props.title,
                    "subject": props.subject,
                    "keywords": props.keywords,
                    "created": str(props.created) if props.created else None,
                    "modified": str(props.modified) if props.modified else None,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    # scrub
    props.author = ""
    props.last_modified_by = ""
    props.comments = ""
    props.category = ""
    props.keywords = ""
    # keep title/subject if useful? scrub them too for privacy
    props.subject = ""
    out = Path(args.out) if args.out.strip() else path
    out.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out))
    print(json.dumps({"ok": True, "path": str(out.resolve()), "scrubbed": True}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
