#!/usr/bin/env python3
"""Prepare, apply, or restore the inspected Codex browser site-status patch."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile


VERSION = "26.1007.71326"
ORIGINAL_SHA256 = "4295ad5e22e0504b53e32daa4844169610fd65a613290593649b97277b12978f"
ORIGINAL = (
    b'async fetchBlocked(e,r){let n=await tk(e,r.endpoint,{method:"GET"});'
    b'if(!n.ok)throw new Error("Browser Use site-status request failed.");'
    b'let o=await n.json();return vS(o)}'
)
PATCHED = ORIGINAL.replace(
    b"return vS(o)",
    b"return vS({...o,feature_status:{...o?.feature_status,agent:!1}})",
)
PLUGINS = ("browser", "chrome")
DEFAULT_ROOT = Path.home() / ".codex/plugins/cache/openai-bundled"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def patch_bytes(data):
    if sha256(data) != ORIGINAL_SHA256:
        raise ValueError("Bundle hash differs from the inspected version")
    if data.count(ORIGINAL) != 1 or PATCHED in data:
        raise ValueError("Expected exactly one original site-status function")
    return data.replace(ORIGINAL, PATCHED, 1)


def target_path(root, plugin):
    return root / plugin / VERSION / "scripts/browser-service.mjs"


def atomic_replace(path, content, mode):
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def prepare(root, output):
    entries = []
    for plugin in PLUGINS:
        target = target_path(root, plugin).resolve(strict=True)
        original = target.read_bytes()
        patched = patch_bytes(original)
        entries.append((plugin, target, original, patched, stat.S_IMODE(target.stat().st_mode)))
    output.mkdir(parents=True, exist_ok=False)
    manifest = {"schema": 1, "version": VERSION, "targets": []}
    for plugin, target, original, patched, mode in entries:
        (output / f"{plugin}.original.mjs").write_bytes(original)
        (output / f"{plugin}.patched.mjs").write_bytes(patched)
        manifest["targets"].append({"plugin": plugin, "path": str(target), "mode": mode,
                                    "original_sha256": sha256(original),
                                    "patched_sha256": sha256(patched)})
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Prepared {len(entries)} bundles in {output}; installed files unchanged")
    for plugin, target, original, patched, _ in entries:
        print(f"{plugin}: {target}\n  {sha256(original)} -> {sha256(patched)}")


def load_plan(directory):
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest.get("schema") != 1 or manifest.get("version") != VERSION:
        raise ValueError("Unsupported manifest")
    entries = manifest.get("targets", [])
    if len(entries) != len(PLUGINS) or {entry["plugin"] for entry in entries} != set(PLUGINS):
        raise ValueError("Manifest must contain browser and chrome exactly once")
    result = []
    for entry in entries:
        plugin = entry["plugin"]
        original = (directory / f"{plugin}.original.mjs").read_bytes()
        patched = (directory / f"{plugin}.patched.mjs").read_bytes()
        expected = patch_bytes(original)
        if (patched != expected or entry["original_sha256"] != sha256(original)
                or entry["patched_sha256"] != sha256(patched)):
            raise ValueError(f"Prepared bundle or manifest changed: {plugin}")
        target = Path(entry["path"])
        if (not target.is_absolute() or target.name != "browser-service.mjs"
                or target.parent.name != "scripts" or target.parent.parent.name != VERSION
                or target.parent.parent.parent.name != plugin):
            raise ValueError(f"Unexpected target path: {target}")
        if target.is_symlink() or not target.is_file():
            raise ValueError(f"Target is no longer a regular file: {target}")
        result.append((target, original, patched))
    if len({entry[0].resolve() for entry in result}) != len(PLUGINS):
        raise ValueError("Targets must be distinct files")
    return result


def change(directory, restore=False):
    entries = load_plan(directory)
    pending = []
    for target, original, patched in entries:
        before, after = (patched, original) if restore else (original, patched)
        current = target.read_bytes()
        if current == after:
            print(f"Already {'restored' if restore else 'patched'}: {target}")
            continue
        if current != before:
            raise ValueError(f"Target changed; refusing to overwrite: {target}")
        pending.append((target, before, after, stat.S_IMODE(target.stat().st_mode)))
    completed = []
    try:
        for target, before, after, mode in pending:
            if target.read_bytes() != before:
                raise ValueError(f"Target changed during operation: {target}")
            atomic_replace(target, after, mode)
            completed.append((target, before, after, mode))
            if target.read_bytes() != after:
                raise ValueError(f"Write verification failed: {target}")
    except Exception as error:
        failures = []
        for target, before, after, mode in reversed(completed):
            try:
                if target.read_bytes() != after:
                    raise ValueError("Target changed after write")
                atomic_replace(target, before, mode)
            except Exception as rollback_error:
                failures.append(f"{target}: {rollback_error}")
        if failures:
            raise RuntimeError(f"{error}; rollback incomplete: {'; '.join(failures)}") from error
        raise
    for target, _, _, _ in completed:
        print(f"{'Restored' if restore else 'Patched'}: {target}")


def status(root):
    for plugin in PLUGINS:
        target = target_path(root, plugin)
        if not target.is_file():
            print(f"{plugin}: missing ({target})")
            continue
        content = target.read_bytes()
        if sha256(content) == ORIGINAL_SHA256:
            state = "inspected original"
        elif content.count(PATCHED) == 1 and ORIGINAL not in content:
            restored = content.replace(PATCHED, ORIGINAL, 1)
            state = "patched" if sha256(restored) == ORIGINAL_SHA256 else "modified / unsupported"
        else:
            state = "modified / unsupported"
        print(f"{plugin}: {state}; sha256={sha256(content)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("status", "prepare"):
        command = commands.add_parser(name)
        command.add_argument("--plugin-root", type=Path, default=DEFAULT_ROOT)
        if name == "prepare":
            command.add_argument("--output", type=Path, required=True)
    for name in ("apply", "restore"):
        command = commands.add_parser(name)
        command.add_argument("--plan", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "status":
            status(args.plugin_root.expanduser().resolve())
        elif args.command == "prepare":
            prepare(args.plugin_root.expanduser().resolve(), args.output.expanduser().resolve())
        else:
            change(args.plan.expanduser().resolve(), restore=args.command == "restore")
    except (ValueError, RuntimeError, OSError, KeyError, TypeError) as error:
        parser.exit(1, f"Error: {error}\n")


if __name__ == "__main__":
    main()
