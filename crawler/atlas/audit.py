"""Read-only catalog audit; provenance observations are not duplicate entries."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .models import fingerprint
from .snapshot import origin_key, atomic_json


def audit(entries):
    observations = Counter(origin_key(r) for r in entries)
    unique = {fingerprint(r): r for r in entries}
    payload_halls = defaultdict(set)
    for r in entries:
        if r["game_link"]:
            query = parse_qs(urlsplit(r["game_link"]).query)
            payload = query["id" if r["kind"] == "base" else "army"][0]
            payload_halls[(r["kind"], r["village"], payload)].add(r["town_hall"])
    return {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "observations": len(entries),
        "unique_entries": len(unique),
        "entries_by_kind": dict(Counter(r["kind"] for r in unique.values())),
        "duplicate_origin_rows": sum(n - 1 for n in observations.values()),
        "additional_provenance_observations": len(observations) - len(unique),
        "cross_hall_shares": [
            {
                "kind": kind,
                "village": village,
                "payload": payload,
                "halls": sorted(halls),
            }
            for (kind, village, payload), halls in payload_halls.items()
            if len(halls) > 1
        ],
        "policy": "One entry per kind/village/hall/share payload; retain each distinct origin and cross-hall applicability.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", default="../data/catalog.json")
    parser.add_argument("--output")
    args = parser.parse_args()
    report = audit(json.loads(Path(args.catalog).read_text())["entries"])
    if args.output:
        atomic_json(Path(args.output), report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if report["duplicate_origin_rows"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
