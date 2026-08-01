"""Thin client for the Prava payment rail, with an offline mock fallback.

Deterministic by default so `nest run` works offline. Set PRAVA_API_KEY and
PRAVA_LIVE=1 to settle against the real sandbox.

NOTE: endpoint paths are placeholders — confirm against https://docs.prava.space.
"""

from __future__ import annotations

import json
import os
import urllib.request


class PravaClient:
    def __init__(self, api_key: str | None = None, base_url: str | None = None) -> None:
        self.api_key = api_key if api_key is not None else os.environ.get("PRAVA_API_KEY", "")
        self.base_url = base_url or os.environ.get("PRAVA_BASE_URL", "https://sandbox.prava.space")
        # Only hit the network when explicitly enabled; keeps sim deterministic + offline.
        self.live = bool(self.api_key) and os.environ.get("PRAVA_LIVE") == "1"

    async def settle(self, *, payer: str, payee: str, amount: int, currency: str, ref: str) -> dict:
        if not self.live:
            return {"ref": ref, "status": "settled", "mock": True}
        # TODO: POST {base}/v1/payments  (confirm path in docs.prava.space)
        return self._post("/v1/payments", {"payer": payer, "payee": payee, "amount": amount, "currency": currency, "ref": ref})

    async def refund(self, ref: str) -> dict:
        if not self.live:
            return {"ref": ref, "status": "refunded", "mock": True}
        # TODO: POST {base}/v1/payments/{ref}/refund
        return self._post(f"/v1/payments/{ref}/refund", {})

    def _post(self, path: str, body: dict) -> dict:
        req = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:  # noqa: S310 (trusted base_url)
            return json.loads(r.read().decode())
