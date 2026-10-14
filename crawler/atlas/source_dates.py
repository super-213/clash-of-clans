"""Source article dates, never game-link creation dates or version evidence."""
from __future__ import annotations

from datetime import date, datetime, timezone
import json
import re
from urllib.parse import urldefrag, urlsplit, unquote
from urllib.parse import urljoin


def normalize_date(value) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            return date.fromisoformat(value).isoformat()
        if not re.match(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}", value):
            return None
        parsed = datetime.fromisoformat(value)
        # An unspecified timezone is not Beijing or UTC. Preserve only the
        # source calendar date, instead of inventing an exact instant.
        if parsed.tzinfo is None:
            return parsed.date().isoformat()
        return parsed.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except ValueError:
        return None


def same_page(left, right):
    if isinstance(left, dict):
        left = left.get("@id") or left.get("url")
    if not isinstance(left, str):
        return False
    try:
        a, b = urlsplit(urldefrag(left)[0]), urlsplit(urldefrag(right)[0])
    except ValueError:
        return False
    return (a.hostname, unquote(a.path).rstrip("/")) == (b.hostname, unquote(b.path).rstrip("/"))


def source_dates(scope, url: str, *, page_metadata=True) -> dict:
    result = {"source_published_at": None, "source_updated_at": None}
    fields = {"source_published_at": ("article:published_time", "datePublished"),
              "source_updated_at": ("article:modified_time", "dateModified")}
    if page_metadata:
        for field, (property_name, _) in fields.items():
            meta = scope.find("meta", attrs={"property": property_name})
            if meta:
                result[field] = normalize_date(meta.get("content"))

    def nodes(value):
        if isinstance(value, list):
            for item in value:
                yield from nodes(item)
        elif isinstance(value, dict):
            yield value
            # Do not interpret recommendation ItemLists as the main article.
            yield from nodes(value.get("@graph", []))

    candidates = []
    for script in scope.select('script[type="application/ld+json"]'):
        try:
            raw = json.loads(script.string or script.get_text())
        except (ValueError, TypeError):
            continue
        for node in nodes(raw):
            types = node.get("@type", [])
            if isinstance(types, str):
                types = [types]
            if not isinstance(types, list) or not any(t in ("Article", "BlogPosting", "NewsArticle") for t in types):
                continue
            if not any(same_page(node.get(key), url) for key in ("url", "@id", "mainEntityOfPage")):
                continue
            candidates.append(node)
    # Prefer timezone-qualified timestamps over date-only duplicate schemas.
    candidates.sort(key=lambda n: sum("T" in (normalize_date(n.get(key)) or "")
                                     for key in ("datePublished", "dateModified")), reverse=True)
    for field, (_, key) in fields.items():
        if result[field] is None:
            result[field] = next((v for n in candidates if (v := normalize_date(n.get(key)))), None)
        if result[field] is None:
            # Only explicit date properties in this article; generic <time>
            # elements often belong to the sidebar or recommended posts.
            for node in scope.select(f'[itemprop="{key}"]'):
                if node.find_parent(["aside", "nav", "footer"]):
                    continue
                owner = node.find_parent("article")
                if owner is not None and owner is not scope:
                    # Page callers may use JSON-LD/meta; article callers get
                    # dates from their own scope, not a nested recommendation.
                    continue
                value = normalize_date(node.get("datetime") or node.get("content"))
                if value:
                    result[field] = value
                    break
    return result


def backfill_cached_dates(entries: list[dict], cache_path: str, sources: list[dict]) -> list[dict]:
    """Fill missing dates from already captured HTML without network requests."""
    from pathlib import Path
    import sqlite3
    from bs4 import BeautifulSoup

    path = Path(cache_path)
    if not path.exists():
        return entries
    by_source = {s["id"]: s for s in sources}
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    result = []
    try:
        for record in entries:
            if record.get("source_published_at") and record.get("source_updated_at"):
                result.append(record)
                continue
            url = record["source_url"]
            row = db.execute('SELECT body FROM responses WHERE url=? AND mime IN (?,?)',
                             (url, 'text/html', 'application/xhtml+xml')).fetchone()
            dates = None
            if row:
                dates = source_dates(BeautifulSoup(row[0], 'html.parser'), url)
            else:
                source = by_source.get(record["source_id"], {})
                if source.get("adapter") == "clashest":
                    listing = f"{source['base_url']}/coc/army/th{record['town_hall']}"
                    row = db.execute('SELECT body FROM responses WHERE url=? AND mime=?',
                                     (listing, 'text/html')).fetchone()
                    if row:
                        soup = BeautifulSoup(row[0], 'html.parser')
                        for article in soup.select('article'):
                            anchor = article.select_one('h3 a[href]')
                            if anchor and same_page(urljoin(listing, anchor['href']), url):
                                dates = source_dates(article, url, page_metadata=False)
                                break
            updated = dict(record)
            for key, value in (dates or {}).items():
                if not updated.get(key):
                    updated[key] = value
            result.append(updated)
    finally:
        db.close()
    return result
