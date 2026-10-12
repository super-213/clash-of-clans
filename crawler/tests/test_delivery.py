import json
from atlas import __main__ as cli
from atlas.http import CrawlError
from atlas.snapshot import origin_key
from test_discovery import record


def test_delivery_failure_replayed_without_duplicate_publication_or_cursor_loss(
    tmp_path, monkeypatch
):
    config = tmp_path / "sources.toml"
    config.write_text("""[[sources]]
id="test"
name="Test"
adapter="layouts"
base_url="https://source.example"
levels=[18]
limit_per_level=4
backfill_limit_per_level=4
max_pages=1
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
            "--publish",
        ],
    )
    sent, fail = [], True

    class FakeFetcher:
        def __init__(self, *args):
            pass

        def close(self):
            pass

    class FakePublisher:
        client = FakeFetcher()
        url = "https://atlas.example"

        def entries(self, rows):
            if fail:
                raise CrawlError("Publish failed")
            sent.extend(rows)
            return len(rows)

        def post(self, path, body):
            pass

    def collect(source, fetcher, levels, limit, on_error, **options):
        assert limit is None and options["max_pages"] is None
        options["state"]["test:18:https://source.example"] = {"complete": True}
        rows = [] if origin_key(record(1)) in options["known"] else [record(1)]
        options["checkpoint"](rows)
        return rows

    monkeypatch.setattr(cli, "Fetcher", FakeFetcher)
    monkeypatch.setattr(cli, "Publisher", FakePublisher)
    monkeypatch.setattr(cli, "collect", collect)
    assert cli.main() == 1
    assert len(json.loads(output.read_text())["entries"]) == 1
    assert not state.exists()
    fail = False
    assert cli.main() == 0
    assert len(sent) == 1 and state.exists()
    assert cli.main() == 0
    assert len(sent) == 1  # receipts prevent same known observation being resent
    # Publishing a local snapshot to a different target must bootstrap it.
    FakePublisher.url = "https://second.example"
    assert cli.main() == 0 and len(sent) == 2


def test_acknowledged_first_detail_survives_later_failure(tmp_path, monkeypatch):
    config = tmp_path / "sources.toml"
    config.write_text("""[[sources]]
id="test"
name="Test"
adapter="layouts"
base_url="https://source.example"
levels=[18]
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
            "--publish",
        ],
    )

    class Fetcher:
        def __init__(self, *args):
            pass

        def close(self):
            pass

    class Publisher:
        url = "https://atlas.example"
        client = Fetcher()

        def entries(self, rows):
            if rows[0]["title"] == "Layout 2":
                raise CrawlError("failed second detail")
            return len(rows)

        def post(self, *args):
            pass

    def collect(*args, **options):
        for n in (1, 2):
            options["state"]["test:18:url"] = {
                "next_url": f"page{n + 1}",
                "complete": False,
            }
            options["checkpoint"]([record(n)])

    monkeypatch.setattr(cli, "Fetcher", Fetcher)
    monkeypatch.setattr(cli, "Publisher", Publisher)
    monkeypatch.setattr(cli, "collect", collect)
    assert cli.main() == 1
    assert json.loads(state.read_text())["test:18:url"]["next_url"] == "page2"
    snapshot = json.loads(output.read_text())
    assert len(snapshot["entries"]) == 2
    assert len(snapshot["publication"]["records"]) == 1
