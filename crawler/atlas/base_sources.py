"""Source-specific discovery and exact image/share pairing for base collections."""

from __future__ import annotations

import re
from urllib.parse import parse_qs, unquote, urljoin, urlsplit
from bs4 import BeautifulSoup
from .http import CrawlError
from .models import make_record


def hall_pages(html: str, url: str, adapter: str) -> dict[int, str]:
    pattern = (
        r"/zh/bases/(\d+)本阵型$"
        if adapter == "clashcodes"
        else r"/th(\d+)-base-layout/$"
    )
    pages = {}
    for a in BeautifulSoup(html, "html.parser").select("a[href]"):
        target = urljoin(url, a["href"])
        match = re.search(pattern, unquote(urlsplit(target).path))
        if match and urlsplit(target).hostname == urlsplit(url).hostname:
            pages[int(match[1])] = target
    if not pages:
        raise CrawlError("Hall navigation selectors changed")
    return pages


def next_listing(html: str, url: str, adapter: str) -> str | None:
    current = urlsplit(url)
    candidates = []
    if adapter == "layouts":
        match = re.search(r"/page_(\d+)/$", current.path)
        number = int(match[1]) if match else 1
        root = re.sub(r"page_\d+/$", "", current.path)
    else:
        number = int(parse_qs(current.query).get("page", ["1"])[0])
        root = unquote(current.path)
    for a in BeautifulSoup(html, "html.parser").select("a[href]"):
        target = urljoin(url, a["href"])
        parsed = urlsplit(target)
        if parsed.hostname != current.hostname:
            continue
        if adapter == "layouts":
            match = re.fullmatch(re.escape(root) + r"page_(\d+)/", parsed.path)
            page = int(match[1]) if match else 0
        else:
            page = (
                int(parse_qs(parsed.query).get("page", ["0"])[0])
                if unquote(parsed.path) == root
                else 0
            )
        if page > number:
            candidates.append((page, target))
    if candidates and min(candidates)[0] != number + 1:
        raise CrawlError("Pagination gap detected; refusing to skip historical pages")
    return min(candidates)[1] if candidates else None


def discover_clashcodes(html: str, url: str) -> list[str]:
    return list(
        dict.fromkeys(
            urljoin(url, a["href"])
            for a in BeautifulSoup(html, "html.parser").select(
                ".post-item h4.title a[href]"
            )
        )
    )


def base_record(
    source: dict, level: int, url: str, link: str, image, index: int
) -> dict:
    name = image.get("alt", "").strip()
    text = name.lower()
    purpose = next(
        (
            p
            for keys, p in [
                (("farming", "资源", "农业"), "farming"),
                (("legend", "trophy", "传奇", "奖杯", "排位"), "trophy"),
                (("hybrid", "混合"), "hybrid"),
                (("war", "cwl", "部落战", "部落对战"), "war"),
            ]
            if any(k in text for k in keys)
        ),
        "war"
        if ":WB:" in parse_qs(urlsplit(link).query).get("id", [""])[0]
        else "general",
    )
    tags = [
        label
        for keys, label in [
            (("anti-3", "anti 3", "防三星"), "防三星"),
            (("anti-2", "anti 2", "防二星", "防两星"), "防两星"),
            (("anti-air", "anti air", "防空"), "防空"),
        ]
        if any(k in text for k in keys)
    ]
    src = image.get("data-src") or image.get("src", "")
    return make_record(
        source,
        kind="base",
        town_hall=level,
        title=(name or f"{level} 本阵型 #{index}")[:200],
        purpose=purpose,
        tags=tags,
        game_link=link,
        image_url=urljoin(url, src),
        source_url=url,
    )


def valid_layout(link: str, level: int) -> bool:
    parsed = urlsplit(link)
    query = parse_qs(parsed.query)
    return (
        parsed.hostname == "link.clashofclans.com"
        and query.get("action") == ["OpenLayout"]
        and query.get("id", [""])[0].startswith(f"TH{level}:")
    )


def parse_clashcodes(html: str, url: str, source: dict, level: int) -> list[dict]:
    records, seen = [], set()
    soup = BeautifulSoup(html, "html.parser")
    # The image itself is wrapped in its official share link. Never pair a
    # sidebar recommendation or a button with an unrelated preceding image.
    for image in soup.select("img.coc-base-map"):
        anchor = image.find_parent("a", href=True)
        if not anchor or not valid_layout(anchor["href"], level):
            continue
        payload = parse_qs(urlsplit(anchor["href"]).query)["id"][0]
        if payload in seen:
            continue
        records.append(
            base_record(source, level, url, anchor["href"], image, len(records) + 1)
        )
        seen.add(payload)
    if not records:
        # Older single-layout pages have one main image and one copy button.
        # This fallback is valid only when the article has an unambiguous 1:1 pair.
        content = soup.select_one(".post-content")
        if content:
            images = content.select("img.center-image")
            buttons = content.select(
                'a.base-link-button[href*="link.clashofclans.com"]'
            )
            if len(images) == len(buttons) == 1 and valid_layout(
                buttons[0]["href"], level
            ):
                records.append(
                    base_record(source, level, url, buttons[0]["href"], images[0], 1)
                )
    if not records:
        raise CrawlError("Clashcodes image/share pairing selectors changed")
    return records


def parse_clashbaselink(html: str, url: str, source: dict, level: int) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    content = soup.select_one("article .gh-content")
    if not content:
        raise CrawlError("ClashBaseLink content selector changed")
    records, image = [], None
    for node in content.descendants:
        if getattr(node, "name", None) == "img" and node.find_parent(
            "figure", class_="kg-image-card"
        ):
            image = node
        if (
            getattr(node, "name", None) == "a"
            and "kg-btn" in node.get("class", [])
            and valid_layout(node.get("href", ""), level)
        ):
            if image is None:
                raise CrawlError(
                    "ClashBaseLink copy button missing its own layout image"
                )
            records.append(
                base_record(source, level, url, node["href"], image, len(records) + 1)
            )
            image = None
    if not records:
        raise CrawlError("ClashBaseLink share/image selectors changed")
    return records
