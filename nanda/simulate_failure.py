"""Simulate the Prava payments layer inside Nanda Town and write a viewable trace.

Resolves the ``prava`` payments plugin via Nanda's ``PluginRegistry`` (exactly as
the simulator does), then runs a real flow and writes a Nanda-format JSONL trace:

  1. a verified buyer -> PrintSmith settlement (CONFIRMED),
  2. the Senso trust gate REFUSING an unverified seller (the failure case),
  3. a refund of the verified order (REFUNDED).

The trace is what makes the failure visible inside Nanda's own tooling:

    python simulate_failure.py
    nest inspect  traces/prava_failure.jsonl     # event breakdown incl. trust_refused
    nest dashboard traces/prava_failure.jsonl     # interactive timeline in the browser
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from nest_core.plugins import PluginRegistry
from nest_sdk import AgentId, Money, PaymentRef

from prava_payments.trust import TrustGate, TrustRefused

BUYER = AgentId("did:buyer:alice")
MERCHANT = AgentId("did:printsmith:store")
SCAMMER = AgentId("did:unknown:scammer")

TRACE = Path("traces/prava_failure.jsonl")


class Trace:
    """Minimal Nanda-format trace writer: one ``{agent, kind, ts, ...}`` JSON line per event."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._f = path.open("w", encoding="utf-8")
        self._t = 0.0

    def emit(self, agent: AgentId | str, kind: str, **extra: object) -> None:
        self._f.write(json.dumps({"agent": str(agent), "kind": kind, "ts": self._t, **extra}) + "\n")
        self._t += 1.0

    def close(self) -> None:
        self._f.close()


async def main() -> None:
    reg = PluginRegistry()
    prava_cls = reg.resolve("payments", "prava")  # discovered via entry point — "via Nanda"
    print(f"resolved payments plugin -> {prava_cls.__module__}.{prava_cls.__name__}\n")

    gate = TrustGate(verified={str(MERCHANT)})  # Senso verifies the PrintSmith store only
    pay = prava_cls(BUYER, initial_balance=1000, trust=gate, balances={})

    tr = Trace(TRACE)
    for a in (BUYER, MERCHANT, SCAMMER):
        tr.emit(a, "start")

    # 1) verified settlement -> CONFIRMED
    ref = PaymentRef("order-dark-knight-a3")
    tr.emit(BUYER, "quote", payee=str(MERCHANT))
    receipt = await pay.pay(MERCHANT, Money(amount=399, currency="INR"), ref)
    status = await pay.verify_payment(ref)
    tr.emit(BUYER, "payment_confirmed", payee=str(MERCHANT), amount=receipt.amount.amount,
            currency=receipt.amount.currency, status=status.name)
    print(f"[OK]      {receipt.payer} -> {receipt.payee}  {receipt.amount.amount} {receipt.amount.currency}  status={status.name}")

    # 2) FAILURE — Senso trust gate refuses the unverified scammer (Prava token withheld)
    try:
        await pay.pay(SCAMMER, Money(amount=250, currency="INR"), PaymentRef("order-scam"))
        print("[ERR]     scammer payment should have been refused")
    except TrustRefused as e:
        tr.emit(BUYER, "trust_refused", payee=str(SCAMMER), reason=str(e))
        print(f"[BLOCKED] {e}")

    # 3) refund the verified order -> REFUNDED
    await pay.refund(ref)
    refunded = await pay.verify_payment(ref)
    tr.emit(BUYER, "refunded", ref=str(ref), status=refunded.name)
    print(f"[REFUND]  {ref} -> status={refunded.name}")

    for a in (BUYER, MERCHANT, SCAMMER):
        tr.emit(a, "stop")
    tr.close()
    print(f"\ntrace -> {TRACE}\n  nest inspect {TRACE}\n  nest dashboard {TRACE}")


if __name__ == "__main__":
    asyncio.run(main())
