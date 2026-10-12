from __future__ import annotations

import hashlib
import os

import httpx

from .http import CrawlError


class Publisher:
    def __init__(self):
        self.url = os.environ.get("ATLAS_API_URL", "").rstrip("/")
        self.token = os.environ.get("ATLAS_INGEST_TOKEN", "")
        if not self.url.startswith("https://") or not self.token:
            raise ValueError("Set HTTPS ATLAS_API_URL and ATLAS_INGEST_TOKEN")
        self.client = httpx.Client(timeout=60, headers={"Authorization": f"Bearer {self.token}"})

    def post(self, path: str, payload: dict):
        # Idempotent ingestion and run IDs make a rerun safe after uncertain delivery.
        response = self.client.post(self.url + path, json=payload)
        if not response.is_success:
            raise CrawlError(f"Ingest failed (HTTP {response.status_code})")
        return response.json()

    def entries(self, entries: list[dict]) -> int:
        accepted = 0
        for offset in range(0, len(entries), 25):
            batch = entries[offset:offset + 25]
            count = self.post("/api/ingest/entries", {"entries": batch})["accepted"]
            if count != len(batch):
                # A disabled source can return HTTP 200 with zero accepted rows.
                # Do not let a historical cursor advance past records never stored.
                raise CrawlError(f"Ingest accepted {count} of {len(batch)} records; cursor not advanced")
            accepted += count
        return accepted


class ImageMirror:
    def __init__(self):
        import boto3
        account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
        self.bucket = os.environ["R2_BUCKET_NAME"]
        self.client = boto3.client("s3", endpoint_url=f"https://{account}.r2.cloudflarestorage.com", region_name="auto",
                                   aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"], aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"])
        self.memo: dict[str, str] = {}

    def mirror(self, url: str, fetcher) -> str:
        if url in self.memo: return self.memo[url]
        body, mime = fetcher.fetch(url, max_bytes=8_000_000)
        if body.startswith(b"\x89PNG\r\n\x1a\n"): ext, detected = "png", "image/png"
        elif body.startswith(b"\xff\xd8\xff"): ext, detected = "jpg", "image/jpeg"
        elif body.startswith(b"RIFF") and body[8:12] == b"WEBP": ext, detected = "webp", "image/webp"
        else: raise CrawlError("Image signature rejected")
        if mime != detected: raise CrawlError("Image MIME/signature mismatch")
        key = hashlib.sha256(body).hexdigest() + "." + ext
        self.client.put_object(Bucket=self.bucket, Key=key, Body=body, ContentType=detected,
                               CacheControl="public,max-age=31536000,immutable")
        self.memo[url] = "/media/" + key
        return self.memo[url]
