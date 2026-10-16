#!/usr/bin/env python3
"""Snapshot selected static evidence without executing analyzed application code."""

import argparse
import hashlib
import json
from pathlib import Path


PLUGIN_MARKERS = [
    ("site-status-response", "function vS(t)", 180),
    ("site-status-url", "function xS(t,", 1850),
    ("site-status-error-definition", 'site_status_blocked:{', 360),
    ("site-status-check-and-cache", 'var NV=1440*60*1e3,Zy=class', 2170),
    ("command-classification", 'function WV(t)', 560),
    ("current-page-dispatch", 'let r=WV(e);switch(r.kind)', 1120),
    ("origin-gate-order", 'async ensureTargetUrlOriginAllowed(e)', 1620),
    ("security-mode-separation", 'var Ky=new Set,AV=new Set', 1570),
    ("runtime-fetch", 'async function tk(t,e,r)', 275),
]

APP_MARKERS = [
    ("main-process-navigation-gate", "function Sie(e,t)", 380),
    ("main-process-cdp-gate", "async executeCdpForBrowserUse(e,t)", 1060),
    ("annotation-site-status", "function CR({appServerClient", 1580),
    ("settings-sync", 'var fS=`/wham/browser/settings`', 740),
]

BOOTSTRAP_MARKERS = [
    ("protocol-allowlist", 'var sE=Object.freeze([`http:`,`https:`])', 510),
]


def snapshot(path, markers):
    raw = path.read_bytes()
    text = raw.decode("utf-8")
    records = []
    for label, marker, length in markers:
        offset = text.find(marker)
        if offset < 0:
            raise ValueError(f"Evidence marker missing: {label} in {path}")
        records.append({
            "label": label,
            "line": text.count("\n", 0, offset) + 1,
            "char_offset": offset,
            "excerpt": text[offset:offset + length],
        })
    return {"source": str(path), "sha256": hashlib.sha256(raw).hexdigest(),
            "size": len(raw), "records": records}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plugin", type=Path, required=True)
    parser.add_argument("--main", type=Path, required=True)
    parser.add_argument("--bootstrap", type=Path, required=True)
    parser.add_argument("--actor-list", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    sources = [snapshot(args.plugin, PLUGIN_MARKERS),
               snapshot(args.main, APP_MARKERS),
               snapshot(args.bootstrap, BOOTSTRAP_MARKERS)]
    raw = args.actor_list.read_bytes()
    actor = json.loads(raw)
    actor_summary = {
        "source": str(args.actor_list),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "counts": {key: len(value) for key, value in actor.items()},
        "taobao_matches": {key: [entry for entry in value
                                  if "taobao.com" in json.dumps(entry)]
                           for key, value in actor.items()},
    }
    document = {"sources": sources, "actor_safety_lists": actor_summary}
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "static-evidence.json").write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n")
    lines = ["# 静态证据摘录", "", "应用代码仅按文本读取，未执行。偏移为 Unicode 字符偏移。", ""]
    for source in sources:
        lines.extend([f"来源：`{source['source']}`", "",
                      f"SHA-256：`{source['sha256']}`", ""])
        for record in source["records"]:
            lines.extend([f"## {record['label']}", "",
                          f"原始行：{record['line']}；字符偏移：{record['char_offset']}。", "",
                          "```javascript", record["excerpt"], "```", ""])
    lines.extend(["## ActorSafetyLists", "", "```json",
                  json.dumps(actor_summary, ensure_ascii=False, indent=2), "```", ""])
    (args.output / "static-evidence.md").write_text("\n".join(lines))
    print(f"Wrote {sum(len(source['records']) for source in sources)} excerpts")
    print("ActorSafetyLists Taobao matches:",
          {key: len(value) for key, value in actor_summary["taobao_matches"].items()})


if __name__ == "__main__":
    main()
