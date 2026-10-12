from __future__ import annotations
import json
from pathlib import Path
from .models import fingerprint


def origin_key(record: dict) -> str:
    # A snapshot contains observations, not just unique shares: preserve every
    # origin so local imports and failed publication retries retain provenance.
    return json.dumps(
        [fingerprint(record), record["source_id"], record["source_url"]],
        separators=(",", ":"),
    )


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temp.replace(path)
