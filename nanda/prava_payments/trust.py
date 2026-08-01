"""Senso-backed trust gate for the Prava payments layer.

Refuses payments to unverified agents. Default is OPEN (verify everyone) so
baseline scenarios run unchanged; pass an allowlist (or a real Senso client) to
enforce verification and demonstrate the failure case.

NOTE: SensoClient is a mock — wire real verification against https://docs.senso.ai.
"""

from __future__ import annotations

import os


class TrustRefused(ValueError):
    """Raised when an agent fails Senso verification and the Prava token is refused."""


class SensoClient:
    """Mock Senso client: returns verified only for allowlisted agents.

    TODO: replace with a real call that checks the agent against Senso's
    verified sources before a payment token is issued.
    """

    def __init__(self, verified: set[str] | None = None, api_key: str | None = None) -> None:
        self._verified = verified or set()
        self._api_key = api_key if api_key is not None else os.environ.get("SENSO_API_KEY", "")

    def is_verified(self, agent_id: str) -> bool:
        return agent_id in self._verified


class TrustGate:
    """Decides whether a counterparty is trustworthy enough to pay.

    - ``verified=None`` (default): open — every agent is trusted (baseline runs).
    - ``verified={...}``: allowlist — only listed agents are trusted.
    - ``senso=SensoClient(...)``: delegate the decision to Senso.
    """

    def __init__(self, verified: set[str] | None = None, senso: SensoClient | None = None) -> None:
        self._verified = verified
        self._senso = senso

    def is_verified(self, agent_id) -> bool:
        aid = str(agent_id)
        if self._senso is not None:
            return self._senso.is_verified(aid)
        if self._verified is None:
            return True
        return aid in self._verified
