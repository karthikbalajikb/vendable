"""Prava payments-layer plugin for Nanda Town.

Implements the ``Payments`` protocol (quote / pay / verify_payment / refund) and
settles through the Prava rail (sandbox, with an offline mock). A Senso trust
gate refuses payments to unverified agents — the required failure case.

Registered via entry point as ``payments: prava`` (see pyproject.toml). Same
shape as the reference ``PrepaidCredits`` so it is a drop-in for the payments
layer: constructed per agent with ``agent_id``.
"""

from __future__ import annotations

from nest_sdk import (
    AgentId,
    Money,
    PaymentRef,
    PaymentStatus,
    Quote,
    Receipt,
    ServiceRef,
)

from .prava_client import PravaClient
from .trust import TrustGate, TrustRefused


class PravaPayments:
    """Agent-to-agent payments over the Prava rail, gated by Senso trust.

    Keeps a local ledger for deterministic simulation and mirrors each
    settlement / refund through Prava (mock offline, real sandbox with keys).

    Example::

        pay = PravaPayments(AgentId("buyer"))
        receipt = await pay.pay(AgentId("merchant"), Money(amount=399), PaymentRef("r1"))
    """

    def __init__(
        self,
        agent_id: AgentId,
        initial_balance: int = 1000,
        *,
        prava: PravaClient | None = None,
        trust: TrustGate | None = None,
        balances: dict[AgentId, int] | None = None,
    ) -> None:
        self._agent_id = agent_id
        self._balances: dict[AgentId, int] = balances if balances is not None else {}
        self._balances.setdefault(agent_id, initial_balance)
        self._payments: dict[PaymentRef, Receipt] = {}
        self._refunded: set[PaymentRef] = set()
        self._prava = prava or PravaClient()
        # Open by default so baseline scenarios run; enforce with an allowlist / Senso.
        self._trust = trust or TrustGate()

    def balance(self, agent: AgentId) -> int:
        return self._balances.get(agent, 0)

    async def quote(self, service: ServiceRef) -> Quote:
        return Quote(service=service, price=Money(amount=10))

    async def pay(self, to: AgentId, amount: Money, ref: PaymentRef) -> Receipt:
        if amount.amount <= 0:
            msg = f"Payment amount must be positive: {amount.amount}"
            raise ValueError(msg)
        if ref in self._payments:
            msg = f"Duplicate payment reference: {ref}"
            raise ValueError(msg)

        # --- Senso trust gate: refuse to pay an unverified counterparty ---
        if not self._trust.is_verified(to):
            msg = f"Payee {to} failed Senso verification; Prava token refused"
            raise TrustRefused(msg)

        payer_balance = self._balances.get(self._agent_id, 0)
        if payer_balance < amount.amount:
            msg = f"Insufficient balance: {payer_balance} < {amount.amount}"
            raise ValueError(msg)

        # Settle through Prava (offline mock unless PRAVA_LIVE=1).
        await self._prava.settle(
            payer=str(self._agent_id),
            payee=str(to),
            amount=amount.amount,
            currency=amount.currency,
            ref=str(ref),
        )

        self._balances[self._agent_id] = payer_balance - amount.amount
        self._balances[to] = self._balances.get(to, 0) + amount.amount
        receipt = Receipt(ref=ref, payer=self._agent_id, payee=to, amount=amount)
        self._payments[ref] = receipt
        return receipt

    async def verify_payment(self, ref: PaymentRef) -> PaymentStatus:
        if ref in self._refunded:
            return PaymentStatus.REFUNDED
        if ref in self._payments:
            return PaymentStatus.CONFIRMED
        return PaymentStatus.FAILED

    async def refund(self, ref: PaymentRef) -> None:
        receipt = self._payments.get(ref)
        if receipt is None:
            msg = f"Payment not found: {ref}"
            raise ValueError(msg)

        payee_balance = self._balances.get(receipt.payee, 0)
        if payee_balance < receipt.amount.amount:
            msg = f"Insufficient balance for refund: {receipt.payee} has {payee_balance}"
            raise ValueError(msg)

        self._balances[receipt.payee] = payee_balance - receipt.amount.amount
        self._balances[receipt.payer] = self._balances.get(receipt.payer, 0) + receipt.amount.amount
        await self._prava.refund(str(ref))
        del self._payments[ref]
        self._refunded.add(ref)
