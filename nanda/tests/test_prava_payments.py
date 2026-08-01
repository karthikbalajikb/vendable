"""Tests for the Prava payments plugin: happy path + required failure cases."""

from __future__ import annotations

import asyncio

import pytest
from nest_sdk import AgentId, Money, PaymentRef, PaymentStatus

from prava_payments.plugin import PravaPayments
from prava_payments.trust import TrustGate, TrustRefused

BUYER = AgentId("buyer")
MERCHANT = AgentId("printsmith")


def run(coro):
    return asyncio.run(coro)


def test_pay_settles_and_confirms():
    pay = PravaPayments(BUYER, initial_balance=1000)
    receipt = run(pay.pay(MERCHANT, Money(amount=399), PaymentRef("r1")))

    assert receipt.payer == BUYER
    assert receipt.payee == MERCHANT
    assert receipt.amount.amount == 399
    assert run(pay.verify_payment(PaymentRef("r1"))) == PaymentStatus.CONFIRMED
    assert pay.balance(BUYER) == 601
    assert pay.balance(MERCHANT) == 399


def test_refund_restores_balance_and_status():
    pay = PravaPayments(BUYER, initial_balance=1000)
    run(pay.pay(MERCHANT, Money(amount=399), PaymentRef("r1")))
    run(pay.refund(PaymentRef("r1")))

    assert run(pay.verify_payment(PaymentRef("r1"))) == PaymentStatus.REFUNDED
    assert pay.balance(BUYER) == 1000
    assert pay.balance(MERCHANT) == 0


def test_unverified_payee_is_refused():
    # Senso trust gate allowlists only the real merchant; a scammer is refused.
    gate = TrustGate(verified={"printsmith"})
    pay = PravaPayments(BUYER, initial_balance=1000, trust=gate)

    with pytest.raises(TrustRefused):
        run(pay.pay(AgentId("scammer"), Money(amount=100), PaymentRef("r2")))

    # No funds moved; nothing recorded.
    assert pay.balance(BUYER) == 1000
    assert run(pay.verify_payment(PaymentRef("r2"))) == PaymentStatus.FAILED


def test_verified_payee_passes_gate():
    gate = TrustGate(verified={"printsmith"})
    pay = PravaPayments(BUYER, initial_balance=1000, trust=gate)
    receipt = run(pay.pay(MERCHANT, Money(amount=199), PaymentRef("r3")))
    assert receipt.amount.amount == 199


def test_duplicate_reference_rejected():
    pay = PravaPayments(BUYER, initial_balance=1000)
    run(pay.pay(MERCHANT, Money(amount=50), PaymentRef("r1")))
    with pytest.raises(ValueError, match="Duplicate"):
        run(pay.pay(MERCHANT, Money(amount=50), PaymentRef("r1")))


def test_insufficient_balance_rejected():
    pay = PravaPayments(BUYER, initial_balance=100)
    with pytest.raises(ValueError, match="Insufficient"):
        run(pay.pay(MERCHANT, Money(amount=399), PaymentRef("r4")))
