import httpx
import pytest

from atlas.http import CrawlError, Fetcher


def build(tmp_path, handler):
    return Fetcher({"allowed_hosts": ["source.example"], "delay_seconds": 0}, str(tmp_path / 'cache.sqlite'),
                   'VillageAtlas/0.1', httpx.Client(transport=httpx.MockTransport(handler)))


def test_disallowed_robots_never_fetches_page(tmp_path):
    requests = []
    def handler(req):
        requests.append(req.url.path)
        return httpx.Response(200, text='User-agent: *\nDisallow: /private')
    f = build(tmp_path, handler)
    with pytest.raises(CrawlError, match='disallows'):
        f.html('https://source.example/private')
    assert requests == ['/robots.txt']
    f.close()


def test_robots_fail_closed_and_allowlist(tmp_path):
    f = build(tmp_path, lambda req: httpx.Response(403))
    with pytest.raises(CrawlError, match='source paused'):
        f.html('https://source.example/base')
    with pytest.raises(CrawlError, match='outside'):
        f.html('https://127.0.0.1/admin')
    f.close()


def test_conditional_get_retains_body_and_429_does_not_replace(tmp_path):
    state = {'count': 0}
    def handler(req):
        if req.url.path == '/robots.txt':
            return httpx.Response(200, text='User-agent: *\nAllow: /')
        state['count'] += 1
        if state['count'] == 1:
            return httpx.Response(200, headers={'Content-Type':'text/html','ETag':'v1'}, text='<h1>Original</h1>')
        assert req.headers['If-None-Match'] == 'v1'
        return httpx.Response(304 if state['count'] == 2 else 429)
    f = build(tmp_path, handler)
    first = f.html('https://source.example/base')
    assert f.html('https://source.example/base') == first
    with pytest.raises(CrawlError, match='HTTP 429'):
        f.html('https://source.example/base')
    assert state['count'] == 3
    assert f.db.execute('SELECT body FROM responses').fetchone()[0] == first.encode()
    f.close()


def test_response_bounds(tmp_path):
    def handler(req):
        return httpx.Response(200, text='User-agent: *\nAllow: /' if req.url.path == '/robots.txt' else 'x'*100)
    f = build(tmp_path, handler)
    with pytest.raises(CrawlError, match='size limit'):
        f.fetch('https://source.example/base', max_bytes=10)
    f.close()
