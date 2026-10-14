from __future__ import annotations

import re
import json
from pathlib import Path
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from .http import CrawlError
from .models import make_record
from .source_dates import source_dates


# Illustration metadata observed in the public hero encyclopedia; never derive URLs from names.
ASSETS = json.loads(Path(__file__).with_name("assets.json").read_text())


def loadout_item(name: str) -> dict:
    return dict(ASSETS.get(name, {"name": name, "image_url": None, "image_source_url": None}))


def clashest_loadout(img, url: str) -> dict:
    name = img["alt"].strip()
    li = img.find_parent("li")
    raw = li.get_text(" ", strip=True) if li else name
    detail = raw.split("—", 1)[1].strip() if "—" in raw else ""
    # Equipment names are title-cased; unknown future names retain text without invented icons.
    # Role labels such as "funnel/cleanup" remain notes, never equipment.
    equipment_text = re.split(r"\(|,", detail, maxsplit=1)[0].strip()
    names = [n.strip() for n in equipment_text.split("+") if n.strip()]
    equipment = [loadout_item(n) for n in names if re.fullmatch(r"[A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)*", n)]
    return {"hero": {"name": name, "image_url": urljoin(url, img["src"]), "image_source_url": url},
            "pet": None, "equipment": equipment, "source_url": url, "source_text": raw,
            "notes": detail if len(equipment) != len(names) else detail[len(equipment_text):].strip(" ,()")}


def discover_layouts(html: str, url: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    return list(dict.fromkeys(urljoin(url, img.find_parent("a")["href"])
                             for img in soup.select("img.base_grid_img") if img.find_parent("a")))


def parse_layout(html: str, url: str, source: dict, level: int) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    link = soup.select_one('a.base_link_button[href*="link.clashofclans.com"]')
    image = soup.select_one('img[src*="/thumb/"]')
    heading = soup.select_one("h1")
    if not image or not heading:
        raise CrawlError("Layout selectors changed or share link/image missing")
    if not link and not soup.select_one(".no_base_link") and "Base link for this layout is temporarily unavailable" not in soup.get_text(" ", strip=True):
        raise CrawlError("Layout share link selector changed")
    original_title = heading.get_text(" ", strip=True)
    text = original_title.lower()
    purpose = next((p for key, p in [("war", "war"), ("farm", "farming"), ("hybrid", "hybrid"), ("defence", "trophy")] if key in text or key in url), "general")
    tags = [label for key, label in [("anti 3", "防三星"), ("anti 2", "防两星"), ("anti air", "防空"), ("anti everything", "综合防守")] if key in text]
    serial = re.search(r"_(\d+)\.html", url)
    labels = {"war": "部落战", "farming": "护资源", "hybrid": "综合", "trophy": "冲杯", "general": "家乡"}
    title = f'{level} 本 · {labels[purpose]}阵型' + (f' #{serial[1]}' if serial else '')
    return make_record(source, kind="base", town_hall=level, title=title, purpose=purpose, tags=tags,
                       game_link=link["href"] if link else None, image_url=urljoin(url, image["src"]), source_url=url,
                       **source_dates(soup, url))


def parse_armies(html: str, url: str, source: dict, level: int) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    records = []
    for article in soup.select("article"):
        link = article.select_one('a[href*="action=CopyArmy"]')
        heading = article.select_one("h3")
        if not link or not heading:
            continue
        units = []
        hero_images = []
        for img in article.select("img[alt]"):
            name = img.get("alt", "").strip()
            if not name:
                continue
            src = img.get("src", "")
            if "/heroes/" in src:
                group, count = "hero", 1
                hero_images.append(img)
            elif "spell" in src:
                group = "spell"
                count_match = re.search(r"(\d+)\s*×", img.parent.get_text("", strip=True))
                if not count_match: raise CrawlError("Spell count selector changed")
                count = int(count_match[1])
            else:
                parent_title = img.parent.get("title", "")
                if parent_title.startswith("Siege:"):
                    group, count = "siege", 1
                else:
                    count_match = re.match(r"(\d+)×", parent_title)
                    if not count_match: continue
                    group, count = "troop", int(count_match[1])
            units.append({"name": name, "count": count, "group": group, "image_url": urljoin(url, src)})
        if not any(u["group"] == "troop" for u in units):
            raise CrawlError("Army troop/image selectors changed")
        title = heading.get_text(" ", strip=True)
        detail = heading.select_one("a[href]")
        source_url = urljoin(url, detail["href"]) if detail else url + "#" + article.get("id", "")
        records.append(make_record(source, kind="army", town_hall=level, title=title, purpose="war", tags=["兵种配图"],
                                   game_link=link["href"], image_url=units[0]["image_url"], units=units, source_url=source_url,
                                   hero_loadouts=[clashest_loadout(img, source_url) for img in hero_images],
                                   **source_dates(article, source_url, page_metadata=False)))
    # Empty selectors must fail loudly; never silently report a healthy empty run.
    if not records:
        raise CrawlError("Army selectors changed or no share links found")
    return records


def parse_blueprint(html: str, url: str, source: dict, level: int) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    heading = soup.find("h2", string=lambda s: s and "Army Composition" in s)
    title = soup.select_one("h1")
    if not heading or not title:
        raise CrawlError("Blueprint composition heading changed")
    # Limit extraction to the composition section; unrelated strategies/ads are ignored.
    nodes = []
    for node in heading.next_siblings:
        if getattr(node, "name", None) == "h2": break
        nodes.append(str(node))
    section = BeautifulSoup("".join(nodes), "html.parser")
    link = section.select_one('a[href*="action=CopyArmy"]')
    image = section.find("img", alt=lambda s: s and "Army Comp" in s)
    heroes = next((p.get_text(" ", strip=True) for p in section.select("p") if p.get_text(strip=True).startswith("Heroes:")), "")
    pairs = re.findall(r"([A-Za-z ]+) \(([^()]+)\)", heroes.removeprefix("Heroes:").strip())
    if not link or not image or not pairs:
        raise CrawlError("Blueprint composition/link/hero selectors changed")
    steps_heading = heading.find_next("h2")
    steps = steps_heading.find_next_sibling("ol") if steps_heading else None
    loadouts = []
    for name, equipment_text in pairs:
        name = name.strip()
        equipment = [loadout_item(n.strip()) for n in equipment_text.split("+")]
        pet, evidence = None, f"{name} ({equipment_text})"
        # Accept only an explicit named hero + 'with <pet>' in the same execution step.
        # The share payload is retained verbatim; unmapped IDs are never guessed.
        for step in steps.select("li") if steps else []:
            raw = step.get_text(" ", strip=True)
            match = re.search(re.escape(name) + r"\b on [^—–;.!?]*[—–]\s*with ([A-Z][A-Za-z ]+),", raw)
            if match:
                pet = loadout_item(match[1].strip())
                evidence += " · " + raw
                break
        loadouts.append({"hero": loadout_item(name), "pet": pet, "equipment": equipment,
                         "source_url": url, "source_text": evidence, "notes": ""})
    return make_record(source, kind="army", town_hall=level, title=title.get_text(" ", strip=True),
                       purpose="war", tags=["英雄装备", "攻略配图"], game_link=link["href"],
                       image_url=urljoin(url, image["src"]), source_url=url, hero_loadouts=loadouts,
                       **source_dates(soup, url))


def collect(source: dict, fetcher, levels: list[int], limit: int | None, on_error, **options) -> list[dict]:
    from .discovery import collect_source
    return collect_source(source, fetcher, levels, limit, on_error, **options)
