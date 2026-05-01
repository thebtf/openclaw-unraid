#!/usr/bin/env python3
"""
Merge Unraid stored container template (my-OpenClaw.xml) with upstream template.

Picks up new fields, ExtraParams, PostArgs from upstream while preserving every
value the user already filled in (tokens, API keys, paths, etc.).

Usage:
    python3 merge-template.py \\
        --stored /boot/config/plugins/dockerMan/templates-user/my-OpenClaw.xml \\
        --upstream /boot/config/plugins/dockerMan/templates-user/openclaw.xml \\
        --output /boot/config/plugins/dockerMan/templates-user/my-OpenClaw.xml

Always writes a backup at <output>.bak before overwriting.
"""

import argparse
import shutil
import sys
from pathlib import Path
from xml.etree import ElementTree as ET


def text_value(elem):
    """Return the text content of an element, treating None and whitespace-only as empty."""
    return (elem.text or "").strip()


def index_configs_by_target(root):
    """
    Map each <Config> element by its @Target attribute -> element.
    Targets are unique within a valid Unraid template (env var name or container path).
    """
    return {cfg.get("Target"): cfg for cfg in root.findall("Config") if cfg.get("Target")}


def merge_template(stored_path: Path, upstream_path: Path, output_path: Path) -> int:
    if not stored_path.exists():
        print(f"FATAL: stored template not found at {stored_path}", file=sys.stderr)
        return 1
    if not upstream_path.exists():
        print(f"FATAL: upstream template not found at {upstream_path}", file=sys.stderr)
        return 1

    stored_tree = ET.parse(stored_path)
    upstream_tree = ET.parse(upstream_path)

    stored_root = stored_tree.getroot()
    upstream_root = upstream_tree.getroot()

    # Take upstream as the base structure (it has the new fields, ExtraParams, PostArgs).
    # Then overlay the user's filled-in values from stored.
    stored_configs = index_configs_by_target(stored_root)
    overlaid = 0
    skipped_new = []

    for upstream_cfg in upstream_root.findall("Config"):
        target = upstream_cfg.get("Target")
        if target in stored_configs:
            stored_text = text_value(stored_configs[target])
            if stored_text:
                upstream_cfg.text = stored_text
                overlaid += 1
        else:
            skipped_new.append(f"{upstream_cfg.get('Name')} ({target})")

    # Carry over user-added <Config> entries from stored that upstream doesn't have.
    # We DROP only entries we can be SURE are template-managed legacy (Type="Path"
    # or Type="Port" — users never add those via Edit Container). For Type="Variable"
    # we always KEEP, even if the Target looks like one of our managed prefixes
    # (OPENCLAW_*, CUSTOM_LLM_*) — the user may have legitimately added an upstream
    # OpenClaw env var (e.g. OPENCLAW_GATEWAY_STARTUP_TRACE) we don't ship in the
    # template. Better to keep occasional legacy orphans (user removes manually
    # once) than to silently nuke a real env var on every template upgrade.
    upstream_targets = {cfg.get("Target") for cfg in upstream_root.findall("Config")}
    upstream_container = upstream_root  # root is <Container>

    for stored_cfg in stored_root.findall("Config"):
        if stored_cfg.get("Target") in upstream_targets:
            continue
        cfg_type = stored_cfg.get("Type", "")
        if cfg_type in ("Path", "Port"):
            print(f"DROPPED legacy {cfg_type} (not in upstream): "
                  f"{stored_cfg.get('Name')} ({stored_cfg.get('Target')})")
            continue
        upstream_container.append(stored_cfg)
        print(f"KEPT <Config> not present in upstream: "
              f"{stored_cfg.get('Name')} ({stored_cfg.get('Target')})")

    # Backup before writing
    backup_path = output_path.with_suffix(output_path.suffix + ".bak")
    shutil.copy2(stored_path, backup_path)

    # Preserve XML declaration and indent for readability
    ET.indent(upstream_tree, space="  ")
    upstream_tree.write(output_path, encoding="utf-8", xml_declaration=True)

    print(f"OK: overlaid {overlaid} user values onto upstream template")
    print(f"OK: backup at {backup_path}")
    if skipped_new:
        print(f"NEW fields from upstream (left at template defaults — fill in via Edit Container if needed):")
        for name in skipped_new:
            print(f"  - {name}")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stored", required=True, type=Path, help="Path to my-OpenClaw.xml (stored copy)")
    ap.add_argument("--upstream", required=True, type=Path, help="Path to upstream openclaw.xml")
    ap.add_argument("--output", required=True, type=Path, help="Where to write the merged template")
    args = ap.parse_args()
    return merge_template(args.stored, args.upstream, args.output)


if __name__ == "__main__":
    sys.exit(main())
