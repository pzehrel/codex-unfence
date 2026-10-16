#!/usr/bin/env python3
"""Read ASAR assets as data; never import or execute packaged code."""

import argparse
import fnmatch
import hashlib
import json
from pathlib import Path
import struct
import tempfile


def entries(node, prefix=""):
    for name, value in node.get("files", {}).items():
        path = prefix + name
        if "files" in value:
            yield from entries(value, path + "/")
        else:
            yield path, value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--include", action="append", required=True)
    parser.add_argument("--search", action="append", default=[])
    parser.add_argument("--context", type=int, default=220)
    parser.add_argument("--limit", type=int, default=12)
    parser.add_argument("--extract-under", type=Path)
    args = parser.parse_args()
    destination = None
    if args.extract_under:
        args.extract_under.mkdir(parents=True, exist_ok=True)
        destination = Path(tempfile.mkdtemp(prefix="asar-", dir=args.extract_under))
        print("Extraction directory:", destination)
    with args.archive.open("rb") as archive:
        prefix = archive.read(16)
        if len(prefix) != 16:
            raise ValueError("Incomplete ASAR header")
        _, header_size, _, json_size = struct.unpack("<4I", prefix)
        if not 0 < json_size <= header_size <= 64 * 1024 * 1024:
            raise ValueError("Invalid ASAR header size")
        header = json.loads(archive.read(json_size))
        base = 8 + header_size
        for name, metadata in entries(header):
            if not any(fnmatch.fnmatchcase(name, pattern) for pattern in args.include):
                continue
            if metadata.get("unpacked") or "offset" not in metadata:
                continue
            archive.seek(base + int(metadata["offset"]))
            raw = archive.read(metadata["size"])
            if len(raw) != metadata["size"]:
                raise ValueError("Truncated asset: " + name)
            if destination:
                output = (destination / name).resolve()
                if not output.is_relative_to(destination.resolve()):
                    raise ValueError("Unsafe archive path: " + name)
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(raw)
                print("EXTRACT", name, len(raw), hashlib.sha256(raw).hexdigest())
            if not args.search:
                continue
            text = raw.decode("utf-8", errors="replace")
            lowered = text.lower()
            for term in args.search:
                start = 0
                count = 0
                while count < args.limit:
                    index = lowered.find(term.lower(), start)
                    if index < 0:
                        break
                    snippet = text[max(0, index - args.context):index + len(term) + args.context]
                    print(json.dumps({"file": name, "term": term, "char_offset": index,
                                      "snippet": snippet}, ensure_ascii=False))
                    start = index + max(1, len(term))
                    count += 1


if __name__ == "__main__":
    main()
