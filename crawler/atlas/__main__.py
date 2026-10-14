from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import tomllib
import uuid

from .adapters import collect
from .http import Fetcher
from .snapshot import origin_key, atomic_json
from .publish import ImageMirror, Publisher
from .compatibility import checked, load_evidence, RULES
from .source_dates import backfill_cached_dates


def now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def content_digest(record):
    return hashlib.sha256(
        json.dumps(record, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def main():
    parser = argparse.ArgumentParser(
        description="Collect public base and army metadata"
    )
    parser.add_argument("--config", default="sources.toml")
    parser.add_argument(
        "--source", default="all", help="all or comma-separated source IDs"
    )
    parser.add_argument(
        "--levels", help="Comma-separated halls; default all configured halls"
    )
    parser.add_argument(
        "--mode", choices=["sync", "incremental", "backfill"], default="sync"
    )
    parser.add_argument(
        "--limit", type=int, help="Optional records per hall; omitted or 0 = unlimited"
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        help="Optional listing pages per hall; omitted or 0 = unlimited",
    )
    parser.add_argument(
        "--max-seconds",
        type=int,
        default=2400,
        help="Graceful time budget (default 2400); checkpoints retained",
    )
    parser.add_argument("--state", help="Cursor JSON; default beside output")
    parser.add_argument(
        "--reset-state",
        action="store_true",
        help="Restart selected cursors, retaining catalog and deduplication",
    )
    parser.add_argument("--output", default="../data/catalog.json")
    parser.add_argument("--cache", default="../data/http-cache.sqlite")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--layout-evidence", type=Path,
                        default=Path(__file__).resolve().parents[1] / "layout-evidence.json")
    parser.add_argument("--recheck-only", action="store_true",
                        help="Reassess snapshot and fill missing source dates from cache; do not crawl")
    args = parser.parse_args()
    if args.limit is not None and args.limit < 0:
        parser.error("--limit must be nonnegative")
    if args.max_pages is not None and args.max_pages < 0:
        parser.error("--max-pages must be nonnegative")
    if args.max_seconds < 1:
        parser.error("--max-seconds must be positive")
    if args.reset_state and args.mode == "incremental":
        parser.error("--reset-state requires --mode sync or backfill")
    sources = tomllib.loads(Path(args.config).read_text())["sources"]
    by_id = {source["id"]: source for source in sources}
    requested = list(dict.fromkeys(args.source.split(",")))
    if args.source != "all" and any(name not in by_id for name in requested):
        parser.error("Unknown source")
    selected = sources if args.source == "all" else [by_id[name] for name in requested]
    levels_filter = [int(x) for x in args.levels.split(",")] if args.levels else None
    publisher = Publisher() if args.publish else None
    deadline = time.monotonic() + args.max_seconds
    Path(args.cache).parent.mkdir(parents=True, exist_ok=True)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    previous = (
        json.loads(output.read_text())
        if output.exists()
        else {"entries": [], "runs": []}
    )
    evidence = load_evidence(args.layout_evidence)
    if args.recheck_only:
        previous["entries"] = backfill_cached_dates(previous["entries"], args.cache, sources)
    entries = {origin_key(e): checked(e, evidence) for e in previous["entries"]}
    state_path = (
        Path(args.state) if args.state else output.with_name("crawl-state.json")
    )
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    if args.reset_state:
        selected_ids = {s["id"] for s in selected}
        state = {
            k: v
            for k, v in state.items()
            if not (
                k.split(":", 2)[0] in selected_ids
                and (levels_filter is None or int(k.split(":", 2)[1]) in levels_filter)
            )
        }
    publication = previous.get("publication", {})
    if publisher and publication.get("target") != getattr(publisher, "url", "test"):
        # A local collection is not proof of remote delivery. Bootstrap each
        # target once, then acknowledge only successfully published observations.
        publication = {"target": getattr(publisher, "url", "test"), "records": {}}
    runs = []

    def save_snapshot():
        atomic_json(
            output,
            {
                "entries": list(entries.values()),
                "runs": (previous.get("runs", []) + runs)[-100:],
                "publication": publication,
            },
        )

    def deliver(records):
        if not publisher:
            return 0
        receipts = publication["records"]
        pending = {
            origin_key(r): r
            for r in records
            if receipts.get(origin_key(r)) != content_digest(r)
        }
        accepted = 0
        values = list(pending.values())
        for offset in range(0, len(values), 25):
            batch = values[offset : offset + 25]
            accepted += publisher.entries(batch)
            receipts.update({origin_key(r): content_digest(r) for r in batch})
            save_snapshot()
        return accepted

    if publisher:
        # Replay unsent data before applying snapshot-based duplicate filtering.
        # A crash after the remote commit may repeat a request; D1 upsert keeps
        # delivery idempotent. Successfully acknowledged data is never resent.
        try:
            deliver(entries.values())
        except Exception as error:
            save_snapshot()
            publisher.client.close()
            print(
                json.dumps(
                    {
                        "event": "publication_replay_failed",
                        "error": f"{type(error).__name__}: {str(error)[:200]}",
                    }
                ),
                flush=True,
            )
            return 1

    # Save rechecks even without publication. Old delivery receipts hash the
    # pre-check content, so the next publish updates existing remote entries too.
    save_snapshot()
    if args.recheck_only:
        from collections import Counter
        counts = Counter(e["compatibility"]["status"] for e in entries.values())
        print(json.dumps({"event": "compatibility_rechecked", "rules_version": RULES["version"],
                          "counts": dict(counts)}, ensure_ascii=False), flush=True)
        if publisher:
            publisher.client.close()
        return 0

    failures = False
    for source in selected:
        if time.monotonic() >= deadline:
            break
        errors, observed = [], set()
        started = now()
        fetcher = Fetcher(
            source, args.cache, os.environ.get("CRAWLER_USER_AGENT", "VillageAtlas/0.1")
        )
        accepted = 0
        candidate_state = deepcopy(state)
        limit, max_pages = args.limit or None, args.max_pages or None
        mirror = None
        print(
            json.dumps(
                {
                    "event": "source_started",
                    "source": source["id"],
                    "mode": args.mode,
                    "limit_per_level": limit,
                    "max_pages": max_pages,
                }
            ),
            flush=True,
        )

        def checkpoint(batch):
            nonlocal accepted, state
            batch = [checked(record, evidence) for record in batch]
            for record in batch:
                key = origin_key(record)
                previous_record = entries.get(key)
                if previous_record and previous_record.get("first_seen_at"):
                    record["first_seen_at"] = previous_record["first_seen_at"]
                elif previous_record is None:
                    record.setdefault("first_seen_at", now())
                if mirror:
                    record["image_url"] = mirror.mirror(record["image_url"], fetcher)
                    for unit in record["units"]:
                        unit["image_url"] = mirror.mirror(unit["image_url"], fetcher)
                    for loadout in record.get("hero_loadouts", []):
                        for item in [
                            loadout["hero"],
                            loadout["pet"],
                            *loadout["equipment"],
                        ]:
                            if (
                                item
                                and item.get("image_url")
                                and (item.get("image_source_url") or "").startswith(
                                    source["base_url"]
                                )
                            ):
                                item["image_url"] = mirror.mirror(
                                    item["image_url"], fetcher
                                )
                key = origin_key(record)
                entries[key] = record
                observed.add(key)
            if batch:
                # Durable data first, then remote receipt, finally cursor. If
                # delivery fails the journal above replays this data next run.
                save_snapshot()
                accepted += deliver(batch)
            if args.mode != "incremental":
                atomic_json(state_path, candidate_state)
                state = deepcopy(candidate_state)

        def progress(count, url):
            if count == 1 or count and count % 100 == 0:
                print(
                    json.dumps(
                        {
                            "event": "collection_progress",
                            "source": source["id"],
                            "collected_in_hall": count,
                            "page": url,
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )

        try:
            if source.get("mirror_images") and publisher:
                mirror = ImageMirror()
            collect(
                source,
                fetcher,
                levels_filter or source["levels"],
                limit,
                errors.append,
                mode=args.mode,
                max_pages=max_pages,
                state=candidate_state,
                progress=progress,
                known=entries,
                checkpoint=checkpoint,
                should_stop=lambda: time.monotonic() >= deadline,
                evidence=evidence,
            )
        except Exception as error:
            errors.append(f"{type(error).__name__}: {str(error)[:200]}")
        finally:
            fetcher.close()
        run = {
            "id": str(uuid.uuid4()),
            "source_id": source["id"],
            "source_name": source["name"],
            "home_url": source["base_url"],
            "started_at": started,
            "finished_at": now(),
            "status": "partial"
            if errors and observed
            else "failed"
            if errors
            else "success",
            "discovered": len(observed),
            "ingested": accepted,
            "error": "; ".join(errors)[:2000] or None,
        }
        if publisher:
            try:
                publisher.post("/api/ingest/runs", run)
            except Exception:
                failures = True
                print(
                    json.dumps({"event": "run_report_failed", "source": source["id"]}),
                    flush=True,
                )
        runs.append(run)
        failures |= bool(errors)
        save_snapshot()
        print(
            json.dumps(
                {
                    "event": "source_finished",
                    **run,
                    "time_budget_exhausted": time.monotonic() >= deadline,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
    if publisher:
        publisher.client.close()
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
