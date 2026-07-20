from __future__ import annotations

from dataclasses import dataclass
import json
from urllib.request import Request, urlopen


DEFAULT_ENDPOINT = "http://100.67.25.118:8191"


@dataclass
class FlaresolverrClient:
    endpoint: str = DEFAULT_ENDPOINT
    enabled: bool = False
    request_cap: int = 0
    request_count: int = 0
    opener: object = urlopen

    def reserve_request(self) -> int:
        if not self.enabled:
            raise RuntimeError("Flaresolverr is disabled")
        if self.request_count >= self.request_cap:
            raise RuntimeError("Flaresolverr request cap reached")
        self.request_count += 1
        return self.request_count

    def health_check(self, timeout_seconds: int = 5) -> int:
        self.reserve_request()
        request = Request(f"{self.endpoint.rstrip('/')}/", method="GET")
        with self.opener(request, timeout=timeout_seconds) as response:
            return response.status

    def solve_url(self, url: str, timeout_seconds: int = 120) -> dict:
        self.reserve_request()
        body = json.dumps({"cmd": "request.get", "url": url, "maxTimeout": timeout_seconds * 1000}).encode("utf-8")
        request = Request(
            f"{self.endpoint.rstrip('/')}/v1",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with self.opener(request, timeout=timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))
