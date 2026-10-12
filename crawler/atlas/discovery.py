"""Bounded incremental discovery and resumable historical collection."""

from __future__ import annotations

from copy import deepcopy
from functools import lru_cache
from .http import CrawlError
from .models import fingerprint
from .snapshot import origin_key
from .base_sources import (
    hall_pages,
    next_listing,
    discover_clashcodes,
    parse_clashcodes,
    parse_clashbaselink,
)


def fatal(error: Exception) -> bool:
    return any(text in str(error) for text in ("HTTP 403", "HTTP 429", "robots.txt"))


def walk_pages(
    fetch,
    start,
    discover,
    parse,
    limit,
    max_pages,
    on_error,
    cursor=None,
    progress=None,
    *,
    known=None,
    skip_urls=None,
    checkpoint=None,
    should_stop=None,
):
    # None means unlimited. Explicit budgets remain available for manual probes.
    state = (
        deepcopy(cursor)
        if cursor
        else {"next_url": start, "pending": [], "seen_pages": [], "complete": False}
    )
    if state["complete"]:
        return [], state
    observed = set()
    known = known or {}
    skip_urls = set(skip_urls or ())
    records, failed, pages = [], [], 0

    def save(batch=()):
        saved = deepcopy(state)
        saved["pending"] = deepcopy(failed) + saved["pending"]
        saved["complete"] = not saved["pending"] and not saved["next_url"]
        if checkpoint:
            # Publication failures propagate; never swallow them as parse errors.
            checkpoint(list(batch), saved)
        return saved

    while limit is None or len(records) < limit:
        if should_stop and should_stop():
            break
        if state["pending"]:
            item = state["pending"].pop(0)
            if item["url"] in skip_urls:
                save()
                continue
            try:
                parsed = parse(fetch(item["url"]), item["url"])
                if not parsed:
                    raise CrawlError("Detail parser returned no records")
                done = set(item.get("done", []))
                remaining, local = [], set()
                for record in parsed:
                    key = origin_key(record)
                    unchanged = key in known and {
                        k: v for k, v in record.items() if k != "game_link"
                    } == {k: v for k, v in known[key].items() if k != "game_link"}
                    if (
                        fingerprint(record) in done
                        or key in observed
                        or key in local
                        or unchanged
                    ):
                        continue
                    local.add(key)
                    remaining.append(record)
                chosen = (
                    remaining if limit is None else remaining[: limit - len(records)]
                )
                if len(chosen) < len(remaining):
                    state["pending"].insert(
                        0,
                        {
                            "url": item["url"],
                            "done": sorted(done | {fingerprint(r) for r in chosen}),
                        },
                    )
            except (CrawlError, ValueError) as error:
                on_error(f"{item['url']}: {error}")
                failed.append(item)
                save()
                if fatal(error):
                    break
                continue
            # Checkpoint data and cursor together after each detail, even empty
            # duplicate-only articles. An interrupt replays at most this detail.
            save(chosen)
            records.extend(chosen)
            observed.update(origin_key(r) for r in chosen)
            if progress:
                progress(len(records), item["url"])
        elif state["next_url"] and (max_pages is None or pages < max_pages):
            url = state["next_url"]
            if url in state["seen_pages"]:
                on_error("Pagination cycle detected; cursor retained for inspection")
                break
            try:
                links, next_url = discover(fetch(url), url)
                if not links:
                    raise CrawlError("Listing selector changed or empty source page")
                state["pending"] = [
                    {"url": link, "done": []} for link in dict.fromkeys(links)
                ]
                state["seen_pages"].append(url)
                state["next_url"] = next_url
                pages += 1
            except (CrawlError, ValueError) as error:
                on_error(f"{url}: {error}")
                break
            save()
        else:
            break
    return records, save()


def collect_source(
    source,
    fetcher,
    levels,
    limit,
    on_error,
    *,
    mode="sync",
    max_pages=None,
    state=None,
    progress=None,
    known=None,
    checkpoint=None,
    should_stop=None,
):
    from .adapters import discover_layouts, parse_layout, parse_armies, parse_blueprint

    results = []
    state = state if state is not None else {}
    if should_stop and should_stop():
        return results

    @lru_cache(maxsize=8)
    def fetch(url):
        # Reuse listing/detail HTML without retaining an unlimited history in
        # memory. The durable HTTP cache lives in SQLite.
        return fetcher.html(url)

    adapter = source["adapter"]
    active = [level for level in levels if level in source["levels"]]
    navigation = {}
    if adapter in ("clashcodes", "clashbaselink") and active:
        navigation = hall_pages(
            fetch(source["index_url"]), source["index_url"], adapter
        )
    for level in active:
        if should_stop and should_stop():
            break
        if adapter == "layouts":
            start = (
                f"{source['base_url']}{source.get('path_prefix', '')}/plans/th_{level}/"
            )
            discover = lambda html, url: (
                discover_layouts(html, url),
                next_listing(html, url, "layouts"),
            )
            parse = lambda html, url: [parse_layout(html, url, source, level)]
        elif adapter in ("clashcodes", "clashbaselink"):
            start = navigation.get(level)
            if not start:
                on_error(f"TH{level}: configured hall missing from source navigation")
                continue
            if adapter == "clashcodes":
                discover = lambda html, url: (
                    discover_clashcodes(html, url),
                    next_listing(html, url, "clashcodes"),
                )
                parse = lambda html, url: parse_clashcodes(html, url, source, level)
            else:
                discover = lambda html, url: ([url], None)
                parse = lambda html, url: parse_clashbaselink(html, url, source, level)
        elif adapter == "clashest":
            start = f"{source['base_url']}/coc/army/th{level}"
            discover = lambda html, url: ([url], None)
            parse = lambda html, url: parse_armies(html, url, source, level)
        elif adapter == "blueprint":
            # Fixed reviewed guide seeds; no claim of full article discovery.
            seeds = [p["url"] for p in source["pages"] if p["level"] == level]
            if not seeds:
                continue
            start = seeds[0]
            discover = lambda html, url: (seeds, None)
            parse = lambda html, url: [parse_blueprint(html, url, source, level)]
        else:
            raise CrawlError("Unknown source adapter")
        key = f"{source['id']}:{level}:{start}"
        errors = []
        cursor = state.get(key) if mode != "incremental" else None
        # A completed monthly pass can discover new content next month. An
        # unfinished pass always continues its pending details / historical page.
        if mode == "sync" and cursor and cursor["complete"]:
            cursor = None

        def commit(batch, saved):
            if mode != "incremental":
                state[key] = saved
            if checkpoint:
                checkpoint(batch)

        # Individual layout detail pages are immutable collection items. Skip
        # known URLs; collection articles must still be parsed for newly added links.
        skip_urls = (
            {
                record["source_url"]
                for record in (known or {}).values()
                if adapter == "layouts"
                and record["source_id"] == source["id"]
                and record["town_hall"] == level
                and record["game_link"]
            }
            if mode != "incremental"
            else set()
        )
        found, cursor = walk_pages(
            fetch,
            start,
            discover,
            parse,
            limit,
            max_pages,
            errors.append,
            cursor,
            progress,
            known=known if mode != "incremental" else None,
            skip_urls=skip_urls,
            checkpoint=commit,
            should_stop=should_stop,
        )
        results.extend(found)
        if mode != "incremental":
            state[key] = cursor
        for error in errors:
            on_error(f"TH{level}: {error}")
        if any(fatal(CrawlError(error)) for error in errors):
            break
    return results
