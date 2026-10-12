from __future__ import annotations

import sqlite3
import time
from urllib.parse import urlsplit, urljoin
from urllib.robotparser import RobotFileParser

import httpx


class CrawlError(RuntimeError):
    pass


class Fetcher:
    """Bounded, sequential HTTP with host allowlists, robots and conditional cache."""

    def __init__(self, source: dict, cache_path: str, user_agent: str, client=None):
        self.source = source
        self.user_agent = user_agent
        self.client = client or httpx.Client(timeout=30, headers={"User-Agent": user_agent}, follow_redirects=False)
        self.db = sqlite3.connect(cache_path)
        self.db.execute("CREATE TABLE IF NOT EXISTS responses (url TEXT PRIMARY KEY, etag TEXT, modified TEXT, body BLOB, mime TEXT)")
        self.robots: dict[str, RobotFileParser] = {}
        self.last_request: dict[str, float] = {}

    def close(self):
        self.client.close()
        self.db.close()

    def allowed_url(self, url: str) -> str:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname not in self.source["allowed_hosts"] or parsed.username or parsed.port:
            raise CrawlError("URL outside configured HTTPS hosts")
        return url

    def _request(self, url: str, headers: dict | None = None, max_bytes=5_000_000):
        for _redirect in range(5):
            self.allowed_url(url)
            host = urlsplit(url).netloc
            wait = max(float(self.source.get("delay_seconds", 2)), self.robots.get(host, RobotFileParser()).crawl_delay(self.user_agent) or 0)
            time.sleep(max(0, wait - (time.monotonic() - self.last_request.get(host, 0))))
            self.last_request[host] = time.monotonic()
            # Do not retry access denials or 429. Next scheduled run will try again.
            for attempt in range(3):
                try:
                    with self.client.stream("GET", url, headers=headers or {}) as response:
                        if response.status_code in (301, 302, 303, 307, 308):
                            url = self.allowed_url(urljoin(url, response.headers.get("location", "")))
                            # Redirect targets are also checked against their robots rules.
                            target = urlsplit(url)
                            if not target.path.endswith('/robots.txt'):
                                self.check_robots(url)
                            break
                        if response.status_code >= 500 and attempt < 2:
                            time.sleep(2 ** (attempt + 1))
                            continue
                        body = bytearray()
                        for chunk in response.iter_bytes():
                            body.extend(chunk)
                            if len(body) > max_bytes:
                                raise CrawlError("Response exceeds size limit")
                        return response.status_code, response.headers, bytes(body)
                except httpx.TransportError:
                    if attempt == 2:
                        raise CrawlError("Network request failed") from None
                    time.sleep(2 ** (attempt + 1))
            else:
                raise CrawlError("Request retries exhausted")
        raise CrawlError("Too many redirects")

    def check_robots(self, url: str):
        self.allowed_url(url)
        parsed = urlsplit(url)
        host = parsed.netloc
        if host not in self.robots:
            robots_url = f"{parsed.scheme}://{host}/robots.txt"
            status, _, body = self._request(robots_url, max_bytes=500_000)
            parser = RobotFileParser()
            if status == 404:
                parser.parse(["User-agent: *", "Allow: /"])
            elif status == 200:
                parser.parse(body.decode("utf-8", errors="replace").splitlines())
            else:
                raise CrawlError(f"robots.txt unavailable (HTTP {status}); source paused")
            self.robots[host] = parser
        if not self.robots[host].can_fetch(self.user_agent, url):
            raise CrawlError("robots.txt disallows this URL")

    def fetch(self, url: str, max_bytes=5_000_000) -> tuple[bytes, str]:
        self.check_robots(url)
        cached = self.db.execute("SELECT etag,modified,body,mime FROM responses WHERE url=?", (url,)).fetchone()
        headers = {}
        if cached:
            if cached[0]: headers["If-None-Match"] = cached[0]
            if cached[1]: headers["If-Modified-Since"] = cached[1]
        status, response_headers, body = self._request(url, headers, max_bytes)
        if status == 304 and cached:
            return cached[2], cached[3]
        if status != 200:
            raise CrawlError(f"HTTP {status}; source content was not replaced")
        mime = response_headers.get("content-type", "").split(";")[0].lower()
        self.db.execute("INSERT OR REPLACE INTO responses VALUES(?,?,?,?,?)",
                        (url, response_headers.get("etag"), response_headers.get("last-modified"), body, mime))
        self.db.commit()
        return body, mime

    def html(self, url: str) -> str:
        body, mime = self.fetch(url)
        if mime not in ("text/html", "application/xhtml+xml"):
            raise CrawlError("Expected an HTML document")
        return body.decode("utf-8", errors="replace")
