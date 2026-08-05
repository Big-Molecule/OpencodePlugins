#!/usr/bin/env python3
"""List Word comments from OOXML (read-only structural)."""
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("docx")
    args = p.parse_args()
    path = Path(args.docx)
    if not path.is_file():
        print(json.dumps({"ok": False, "error": f"not found: {path}"}))
        return 1

    comments = []
    try:
        with zipfile.ZipFile(path, "r") as zf:
            if "word/comments.xml" not in zf.namelist():
                print(json.dumps({"ok": True, "path": str(path.resolve()), "comments": [], "note": "no comments part"}))
                return 0
            root = ET.fromstring(zf.read("word/comments.xml"))
            for c in root.findall("w:comment", NS):
                cid = c.get(f"{{{NS['w']}}}id")
                author = c.get(f"{{{NS['w']}}}author")
                date = c.get(f"{{{NS['w']}}}date")
                texts = [t.text or "" for t in c.findall(".//w:t", NS)]
                comments.append(
                    {
                        "id": cid,
                        "author": author,
                        "date": date,
                        "text": "".join(texts).strip(),
                    }
                )
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1

    print(json.dumps({"ok": True, "path": str(path.resolve()), "comments": comments}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
