import httpx
import pytest
from atlas.publish import Publisher
from atlas.http import CrawlError


def publisher(monkeypatch, handle):
    monkeypatch.setenv('ATLAS_API_URL', 'https://source.example')
    monkeypatch.setenv('ATLAS_INGEST_TOKEN', 'test-only-token')
    result = Publisher()
    result.client.close()
    result.client = httpx.Client(transport=httpx.MockTransport(handle))
    return result


def test_disabled_source_accepts_zero_without_advancing_cursor(monkeypatch):
    client = publisher(monkeypatch, lambda request: httpx.Response(200, json={'accepted': 0}))
    try:
        with pytest.raises(CrawlError, match='cursor not advanced'):
            client.entries([{'title': 'not accepted'}])
    finally:
        client.client.close()


def test_publication_batches_remain_bounded(monkeypatch):
    import json
    sizes = []
    def handle(request):
        size = len(json.loads(request.content)['entries'])
        sizes.append(size)
        return httpx.Response(200, json={'accepted': size})
    client = publisher(monkeypatch, handle)
    try:
        assert client.entries([{'title': 'entry'} for _ in range(27)]) == 27
        assert sizes == [25, 2]
    finally:
        client.client.close()
