import json
from pathlib import Path
import pytest
from atlas.base_sources import (
    hall_pages,
    next_listing,
    parse_clashcodes,
    parse_clashbaselink,
)
from atlas.discovery import walk_pages
from atlas.http import CrawlError
from atlas.models import make_record, fingerprint
from atlas.snapshot import origin_key

SOURCE = {"id": "test", "name": "Test"}


def record(n, **values):
    return make_record(
        SOURCE,
        kind="base",
        town_hall=18,
        title=f"Layout {n}",
        purpose="war",
        game_link=f"https://link.clashofclans.com/en?action=OpenLayout&id=TH18:WB:{n}",
        image_url=f"https://source.example/{n}.jpg",
        source_url="https://source.example/article",
        **values,
    )


def test_exact_clashcodes_image_share_pairs_and_scope():
    html = """<h1>Two layouts</h1>
    <a href="https://link.clashofclans.com/en?action=OpenLayout&amp;id=TH18:WB:one"><img class="coc-base-map" alt="18本防三星部落战阵型" src="/one.jpg"></a>
    <a class="base-link-button" href="https://link.clashofclans.com/en?action=OpenLayout&amp;id=TH18:WB:one">Copy</a>
    <a href="https://link.clashofclans.com/jp?action=OpenLayout&amp;id=TH18:HV:two"><img class="coc-base-map" alt="18本传奇杯阵型" data-src="/two.jpg" src="data:image/gif;base64,blank"></a>
    <aside><a href="https://link.clashofclans.com/en?action=OpenLayout&amp;id=TH18:WB:advert">Recommendation without its image</a></aside>
    <a href="https://link.clashofclans.com/en?action=OpenLayout&amp;id=BH10:WB:builder"><img class="coc-base-map" src="/builder.jpg"></a>"""
    items = parse_clashcodes(html, "https://source.example/article", SOURCE, 18)
    assert len(items) == 2
    assert [r["image_url"] for r in items] == [
        "https://source.example/one.jpg",
        "https://source.example/two.jpg",
    ]
    assert [r["purpose"] for r in items] == ["war", "trophy"]
    assert items[0]["tags"] == ["防三星"]
    assert items[1]["game_link"].endswith("id=TH18:HV:two")
    with pytest.raises(CrawlError):
        parse_clashcodes(
            html.replace("coc-base-map", "changed"),
            "https://source.example/article",
            SOURCE,
            18,
        )


def test_clashbaselink_never_reuses_an_image_for_a_later_button():
    html = """<article><section class="gh-content"><figure class="kg-image-card"><img src="/one.webp" alt="TH18 anti-3 war"></figure>
    <div><a class="kg-btn" href="https://link.clashofclans.com/en?action=OpenLayout&amp;id=TH18:WB:one">Copy</a></div>
    <figure class="kg-image-card"><img src="/two.webp" alt="TH18 farming"></figure>
    <div><a class="kg-btn" href="https://link.clashofclans.com/en?action=OpenLayout&amp;id=TH18:HV:two">Copy</a></div></section></article>"""
    items = parse_clashbaselink(html, "https://source.example/article", SOURCE, 18)
    assert len(items) == 2
    assert items[1]["image_url"] == "https://source.example/two.webp"
    assert items[1]["purpose"] == "farming"
    with pytest.raises(CrawlError, match="own layout image"):
        parse_clashbaselink(
            html.replace(
                '<figure class="kg-image-card"><img src="/two.webp" alt="TH18 farming"></figure>',
                "",
            ),
            "https://source.example/article",
            SOURCE,
            18,
        )


def test_source_navigation_and_pagination_exclude_other_halls_and_hosts():
    html = '<a href="/zh/bases/18本阵型">18本</a><a href="https://other.example/zh/bases/17本阵型">bad</a><a href="/zh/bases/建筑大师基地">builder</a>'
    assert hall_pages(html, "https://source.example/zh/", "clashcodes") == {
        18: "https://source.example/zh/bases/18本阵型"
    }
    html = '<a href="/zh/plans/th_18/page_3/">3</a><a href="/zh/plans/th_18/page_2/">2</a><a href="/zh/plans/th_17/page_2/">bad</a><a href="https://other.example/zh/plans/th_18/page_2/">bad</a>'
    assert next_listing(
        html, "https://source.example/zh/plans/th_18/", "layouts"
    ).endswith("/page_2/")
    assert (
        next_listing(html, "https://source.example/zh/plans/th_18/page_3/", "layouts")
        is None
    )
    html = '<a href="/zh/bases/18%E6%9C%AC%E9%98%B5%E5%9E%8B?page=2">2</a><a href="/zh/bases/18本阵型?page=1">1</a>'
    assert next_listing(
        html, "https://source.example/zh/bases/18本阵型", "clashcodes"
    ).endswith("page=2")
    with pytest.raises(CrawlError, match="gap"):
        next_listing(
            '<a href="/zh/plans/th_18/page_27/">last</a>',
            "https://source.example/zh/plans/th_18/",
            "layouts",
        )


def test_backfill_resumes_inside_collection_without_skipping_reordered_records():
    calls, errors = [], []

    def fetch(url):
        calls.append(url)
        return url

    def discover(html, url):
        return (
            (["article-one"], "page-two")
            if url == "page-one"
            else (["article-two"], None)
        )

    def parse(html, url):
        return [record(i) for i in ([1, 2, 3] if url == "article-one" else [4, 5])]

    first, cursor = walk_pages(fetch, "page-one", discover, parse, 2, 1, errors.append)
    assert [r["title"] for r in first] == ["Layout 1", "Layout 2"]
    assert cursor["pending"][0]["url"] == "article-one"
    assert not cursor["complete"]

    # New content inserted before an already processed row must not be lost.
    def changed(html, url):
        return [record(i) for i in ([6, 1, 2, 3] if url == "article-one" else [4, 5])]

    second, cursor = walk_pages(
        fetch, "page-one", discover, changed, 10, 1, errors.append, cursor
    )
    assert [r["title"] for r in second] == [
        "Layout 6",
        "Layout 3",
        "Layout 4",
        "Layout 5",
    ]
    assert calls.count("page-one") == 1
    assert cursor["complete"] and not errors
    final, _ = walk_pages(
        fetch, "page-one", discover, changed, 10, 1, errors.append, cursor
    )
    assert final == []


def test_page_budget_and_failed_page_are_resumable():
    def discover(html, url):
        return ([url + "-article"], "page-two" if url == "page-one" else None)

    def parse(html, url):
        return [record(1 if url.startswith("page-one") else 2)]

    errors = []
    rows, cursor = walk_pages(
        lambda u: u, "page-one", discover, parse, 50, 1, errors.append
    )
    assert len(rows) == 1 and cursor["next_url"] == "page-two"

    def deny(url):
        raise CrawlError("HTTP 403")

    rows, failed = walk_pages(
        deny, "page-one", discover, parse, 50, 1, errors.append, cursor
    )
    assert not rows and failed["next_url"] == "page-two" and not failed["complete"]
    rows, _ = walk_pages(
        lambda u: u, "page-one", discover, parse, 50, 1, errors.append, failed
    )
    assert rows[0]["title"] == "Layout 2"


def test_cycles_fail_loudly_and_snapshot_keeps_multiple_origins():
    errors = []
    rows, cursor = walk_pages(
        lambda u: u,
        "p",
        lambda h, u: (["a"], "p"),
        lambda h, u: [record(1)],
        50,
        3,
        errors.append,
    )
    assert len(rows) == 1 and "cycle" in errors[0] and not cursor["complete"]
    first = record(1)
    second = {
        **first,
        "source_id": "second",
        "source_url": "https://second.example/layout",
    }
    assert fingerprint(first) == fingerprint(second)
    assert origin_key(first) != origin_key(second)


def test_failed_publication_does_not_advance_cursor(tmp_path, monkeypatch):
    from atlas import __main__ as cli

    config = tmp_path / "sources.toml"
    config.write_text("""[[sources]]
id="test"
name="Test"
adapter="layouts"
base_url="https://source.example"
allowed_hosts=["source.example"]
levels=[18]
limit_per_level=12
""")
    output, state = tmp_path / "catalog.json", tmp_path / "state.json"
    monkeypatch.setattr(
        "sys.argv",
        [
            "atlas",
            "--config",
            str(config),
            "--output",
            str(output),
            "--state",
            str(state),
            "--cache",
            str(tmp_path / "cache.sqlite"),
            "--mode",
            "backfill",
            "--publish",
        ],
    )

    class FakeFetcher:
        def __init__(self, *args):
            pass

        def close(self):
            pass

    class FakePublisher:
        client = FakeFetcher()

        def entries(self, records):
            raise CrawlError("Publish failed")

        def post(self, path, body):
            pass

    def collect(source, fetcher, levels, limit, on_error, **options):
        options["state"]["test:18:https://source.example"] = {"complete": True}
        options["checkpoint"]([record(1)])
        return [record(1)]

    monkeypatch.setattr(cli, "Fetcher", FakeFetcher)
    monkeypatch.setattr(cli, "Publisher", FakePublisher)
    monkeypatch.setattr(cli, "collect", collect)
    assert cli.main() == 1
    assert len(json.loads(output.read_text())["entries"]) == 1
    assert not state.exists()


def test_clashcodes_single_page_requires_one_to_one_pair():
    html = """<div class="post-content"><img class="center-image" alt="18本混合阵型" src="/single.jpg">
    <a class="base-link-button" href="https://link.clashofclans.com/en?action=OpenLayout&amp;id=TH18:HV:single">Copy</a></div>
    <aside><img class="center-image" src="/advert.jpg"></aside>"""
    items = parse_clashcodes(html, "https://source.example/article", SOURCE, 18)
    assert len(items) == 1 and items[0]["image_url"].endswith("/single.jpg")
    assert items[0]["purpose"] == "hybrid"
    with pytest.raises(CrawlError):
        parse_clashcodes(
            html.replace(
                "</div>", '<img class="center-image" src="/unclear.jpg"></div>'
            ),
            "https://source.example/article",
            SOURCE,
            18,
        )


def test_denied_detail_stops_source_and_retains_pending_articles():
    calls, errors = [], []

    def deny(url):
        calls.append(url)
        if url == "a":
            raise CrawlError("HTTP 429")
        return url

    rows, cursor = walk_pages(
        deny,
        "p",
        lambda h, u: (["a", "b"], None),
        lambda h, u: [record(1)],
        12,
        2,
        errors.append,
    )
    assert rows == [] and calls == ["p", "a"]
    assert [item["url"] for item in cursor["pending"]] == ["a", "b"]
    assert not cursor["complete"]
    assert "a: HTTP 429" in errors[0]


def test_unlimited_pages_dedup_share_variants_and_skip_known_details():
    calls = []
    old = {**record(1), "source_url": "https://source.example/old"}

    def fetch(url):
        calls.append(url)
        return url

    def discover(html, url):
        page = int(url[1:])
        return (["old", f"a{page}", f"a{page}"], f"p{page + 1}" if page < 5 else None)

    def parse(html, url):
        n = int(url[1:]) + 1
        one = record(n)
        variant = {
            **one,
            "game_link": f"https://link.clashofclans.com/cn?utm_source=tracking&id=TH18%3AWB%3A{n}&action=OpenLayout",
        }
        return [one, variant]

    rows, cursor = walk_pages(
        fetch,
        "p1",
        discover,
        parse,
        None,
        None,
        pytest.fail,
        known={origin_key(old): old},
        skip_urls={"old"},
    )
    assert len(rows) == 5  # not 10 identical share payloads
    assert "old" not in calls
    assert calls.count("p1") == 1 and "p5" in calls
    assert cursor["complete"]


def test_checkpoint_interrupt_replays_only_uncommitted_detail():
    durable, data, calls = {}, {}, []

    def fetch(url):
        calls.append(url)
        return url

    def parse(html, url):
        return [record(int(url[1:]))]

    def save(batch, cursor):
        if batch and batch[0]["title"] == "Layout 2":
            raise RuntimeError("process interrupted before publish")
        durable.clear()
        durable.update(json.loads(json.dumps(cursor)))
        data.update({origin_key(r): r for r in batch})

    with pytest.raises(RuntimeError, match="interrupted"):
        walk_pages(
            fetch,
            "p1",
            lambda h, u: (["a1", "a2", "a3"], None),
            parse,
            None,
            None,
            pytest.fail,
            checkpoint=save,
        )
    assert durable["pending"][0]["url"] == "a2"
    rows, cursor = walk_pages(
        fetch,
        "p1",
        lambda h, u: pytest.fail("listing refetched"),
        parse,
        None,
        None,
        pytest.fail,
        durable,
        known=data,
    )
    assert [r["title"] for r in rows] == ["Layout 2", "Layout 3"]
    assert calls.count("a1") == 1 and calls.count("p1") == 1
    assert cursor["complete"]


def test_graceful_deadline_saves_pending_work_without_error():
    stopped, saved = False, []

    def checkpoint(batch, cursor):
        nonlocal stopped
        saved.append(cursor)
        if batch:
            stopped = True

    rows, cursor = walk_pages(
        lambda u: u,
        "p1",
        lambda h, u: (["a1", "a2"], "p2"),
        lambda h, u: [record(int(u[1:]))],
        None,
        None,
        pytest.fail,
        checkpoint=checkpoint,
        should_stop=lambda: stopped,
    )
    assert len(rows) == 1 and not cursor["complete"]
    assert cursor["pending"] == [{"url": "a2", "done": []}]
    assert cursor["next_url"] == "p2"


def test_sync_resumes_history_then_completed_pass_discovers_new_links(monkeypatch):
    from atlas.discovery import collect_source
    from atlas import adapters

    source = {
        **SOURCE,
        "adapter": "layouts",
        "base_url": "https://source.example",
        "levels": [18],
    }
    start = "https://source.example/plans/th_18/"
    state = {
        f"test:18:{start}": {
            "next_url": None,
            "pending": [{"url": "https://source.example/a2", "done": []}],
            "seen_pages": [start],
            "complete": False,
        }
    }
    old = {**record(1), "source_url": "https://source.example/a1"}
    known = {origin_key(old): old}
    calls = []

    class Fetcher:
        def html(self, url):
            calls.append(url)
            return "<html></html>"

    monkeypatch.setattr(
        adapters,
        "discover_layouts",
        lambda h, u: [
            "https://source.example/a1",
            "https://source.example/a2",
            "https://source.example/a3",
        ],
    )
    monkeypatch.setattr(
        adapters,
        "parse_layout",
        lambda h, u, s, l: {**record(int(u.rsplit("/a", 1)[1])), "source_url": u},
    )
    rows = collect_source(
        source,
        Fetcher(),
        [18],
        None,
        pytest.fail,
        mode="sync",
        state=state,
        known=known,
    )
    assert [r["title"] for r in rows] == ["Layout 2"] and start not in calls
    known.update({origin_key(r): r for r in rows})
    rows = collect_source(
        source,
        Fetcher(),
        [18],
        None,
        pytest.fail,
        mode="sync",
        state=state,
        known=known,
    )
    assert [r["title"] for r in rows] == ["Layout 3"]
    assert calls == [
        "https://source.example/a2",
        start,
        "https://source.example/a3",
    ]  # completed pass scans lists, skips known details
    assert state[f"test:18:{start}"]["complete"]


def test_snapshot_dedup_preserves_new_provenance_for_same_share():
    first = record(1)
    other = {
        **first,
        "source_id": "other",
        "source_url": "https://other.example/article",
    }
    rows, _ = walk_pages(
        lambda u: u,
        "p",
        lambda h, u: (["a"], None),
        lambda h, u: [first, other, other],
        None,
        None,
        pytest.fail,
        known={origin_key(first): first},
    )
    assert rows == [other]
    assert fingerprint(rows[0]) == fingerprint(first)


def test_known_share_updates_metadata_without_creating_another_identity():
    old = record(1)
    updated = {**old, "title": "Updated strategy and equipment"}
    rows, _ = walk_pages(
        lambda u: u,
        "p",
        lambda h, u: (["a"], None),
        lambda h, u: [updated, updated],
        None,
        None,
        pytest.fail,
        known={origin_key(old): old},
    )
    assert rows == [updated]
    assert origin_key(updated) == origin_key(old)


def test_known_share_with_only_tracking_change_is_not_recollected():
    old = record(1)
    variant = {
        **old,
        "game_link": "https://link.clashofclans.com/cn?utm_source=other&id=TH18%3AWB%3A1&action=OpenLayout",
    }
    rows, _ = walk_pages(
        lambda u: u,
        "p",
        lambda h, u: (["a"], None),
        lambda h, u: [variant],
        None,
        None,
        pytest.fail,
        known={origin_key(old): old},
    )
    assert rows == []


def test_audit_distinguishes_provenance_and_cross_hall_applicability():
    from atlas.audit import audit

    first = record(1)
    other = {**first, "source_id": "other", "source_url": "https://other.example/a"}
    army = {
        **first,
        "kind": "army",
        "town_hall": 15,
        "game_link": "https://link.clashofclans.com/en?action=CopyArmy&army=u1x1",
    }
    report = audit([first, other, army, {**army, "town_hall": 16}])
    assert report["unique_entries"] == 3
    assert report["duplicate_origin_rows"] == 0
    assert report["additional_provenance_observations"] == 1
    assert report["cross_hall_shares"][0]["halls"] == [15, 16]
    assert audit([first, first])["duplicate_origin_rows"] == 1
