from __future__ import annotations

import hashlib
import re
from urllib.parse import parse_qs, urlsplit


def fingerprint(record: dict) -> str:
    validate_record(record)
    if not record["game_link"]:
        return hashlib.sha256(f'{record["kind"]}:{record["village"]}:{record["town_hall"]}:source:{record["source_url"]}'.encode()).hexdigest()
    query = parse_qs(urlsplit(record["game_link"]).query)
    payload = query["id" if record["kind"] == "base" else "army"][0]
    return hashlib.sha256(f'{record["kind"]}:{record["village"]}:{record["town_hall"]}:{payload}'.encode()).hexdigest()


def validate_record(record: dict) -> None:
    if record["game_link"] is None and record["kind"] != "base":
        raise ValueError("Army share link required")
    url = urlsplit(record["game_link"] or "https://link.clashofclans.com")
    query = parse_qs(url.query)
    kind = record["kind"]
    if kind not in ("base", "army") or record["village"] not in ("home", "builder"):
        raise ValueError("Unknown content type")
    if url.scheme != "https" or url.hostname != "link.clashofclans.com" or url.port or url.username:
        raise ValueError("Not an official game share URL")
    expected = "OpenLayout" if kind == "base" else "CopyArmy"
    if record["game_link"] and query.get("action") != [expected]:
        raise ValueError("Unexpected share action")
    payload = query.get("id" if kind == "base" else "army", [""])[0]
    if record["game_link"] and not payload:
        raise ValueError("Missing share payload")
    if kind == "base" and record["game_link"]:
        prefix = "TH" if record["village"] == "home" else "BH"
        if not payload.startswith(f'{prefix}{record["town_hall"]}:'):
            raise ValueError("Hall does not match layout")
    if not 1 <= record["town_hall"] <= 50:
        raise ValueError("Invalid hall")
    for field in ("title", "source_id", "source_url", "source_name", "image_url"):
        if not record.get(field):
            raise ValueError(f"Missing {field}")
    urls = [record["source_url"], record["image_url"]] + [u["image_url"] for u in record["units"]]
    loadouts = record.get("hero_loadouts", [])
    if len(loadouts) > 8:
        raise ValueError("Too many heroes")
    for loadout in loadouts:
        if len(loadout["equipment"]) > 2 or len(loadout["source_text"]) > 1500:
            raise ValueError("Invalid hero loadout")
        urls.append(loadout["source_url"])
        for item in [loadout["hero"], loadout["pet"], *loadout["equipment"]]:
            if item is None: continue
            if not isinstance(item.get("name"), str) or not 1 <= len(item["name"]) <= 100:
                raise ValueError("Invalid loadout name")
            urls.extend(item[key] for key in ("image_url", "image_source_url") if item.get(key))
    for value in urls:
        if re.fullmatch(r"/media/[a-f0-9]{64}\.(webp|png|jpg)", value):
            continue
        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username:
            raise ValueError("Only HTTPS images and sources are supported")


def make_record(source: dict, **values) -> dict:
    record = {"village": "home", "tags": [], "units": [], "hero_loadouts": [], "source_id": source["id"],
              "source_name": source["name"], **values}
    validate_record(record)
    return record
