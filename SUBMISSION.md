# Vendable — Devfolio submission (copy‑paste)

> Agentic Commerce Hackathon (NandaHack × Prava), Jul 31 – Aug 2 2026.
> Tracks entered: **Localhost** (Most Startup‑Ready), **Senso** (Discovery & Trust), **Project NANDA** (Best Prava Adapter for Nanda Town).
> Repo: https://github.com/karthikbalajikb/vendable · Builder: Karthik Balaji (Copilotverse.IO)

Fill the `[…]` placeholders (video link, live txn id, PR link) before you hit submit.

---

## Project name
**Vendable**

## Tagline
Give us your store URL — we make it an agent other AIs can **discover, trust, and buy from**.

## Technologies used (list these exactly)
Prava · Senso · Project NANDA / Nanda Town (nest‑core, AgentFacts) · webcmd · TypeScript · Node.js · Python · MCP (ChatGPT connector) · Supabase · Vercel · OpenAI · Anthropic

## Tracks applied
Localhost — Most Startup‑Ready Product · Senso — Agent Commerce Discovery & Trust · Project NANDA — Best Prava Adapter for Nanda Town

---

## The problem it solves
**Who:** independent / no‑API merchants, and the AI buyer agents that will soon shop on people's behalf.

**Problem:** commerce is shifting from humans clicking to **agents buying**. Almost no store is ready for that — it isn't machine‑discoverable, an agent has no way to *verify* the merchant, and there's no clean way to *pay* without exposing card data. And an agent should never pay a merchant it can't trust.

**Product — Vendable:** paste a store URL and we turn it into an agent other AIs can:
- **Discover** — we crawl even no‑API stores (webcmd) and host a product feed, an Agent Commerce Manifest, ACP/UCP endpoints, and a NANDA‑compatible **AgentFacts** card.
- **Trust** — we ingest the merchant's facts into **Senso** and verify them with grounded, cited answers → a trust score.
- **Certify** — payable + Senso‑verified + valid‑manifest stores get a self‑issued, NANDA‑compatible **AgentFacts** certificate.
- **Buy from** — an AI buyer agent pays **headlessly over Prava** (owner approves a mandate once; the agent charges within caps, no human per purchase), behind a **trust gate** that refuses payment to unverified merchants.

One paste → a merchant that is discoverable, verifiable, and payable by agents.

## Prava integration & transaction outcome
- **Live Prava sandbox**, session + mandate APIs. The owner approves a spending **mandate** once (passkey / Touch ID); the buyer agent then **charges it headlessly** with per‑charge product context (title, price, product link) — no human per purchase.
- **Success:** a charge returns a one‑time, **merchant‑scoped virtual card** (`token` + `dynamicCvv`), the mandate budget decrements, and (when a store fulfillment endpoint is configured) we create the order in the merchant's store. Live example: `[txn_… · ₹199 · settled · headless mandate]`.
- **Failure handling (captured, not swallowed):** over‑cap / per‑cycle / **untrusted‑merchant** attempts are declined and surfaced — e.g. *"Senso trust gate refused the Prava token — no charge made."*

## Partner‑track implementation & evidence

### Senso — Agent Commerce Discovery & Trust
Senso **materially decides** whether the transaction can happen. We `POST /org/kb/raw` to ingest each merchant's facts *from the product* (no CLI), then `POST /org/search` for **grounded, cited** answers (is it legitimate, what it sells, how an agent pays it). That yields a trust score — and the buyer agent's **trust gate withholds the Prava token** from any merchant that isn't Senso‑verified.
- Evidence: grounded cited answers, score (e.g. 100/A · "Senso live"), and the live **trust‑gate refusal** (toggle "simulate untrusted" in the Buyer Agent → Prava token refused → no charge).
- Honest framing (stated in‑product): this is a **grounded facts check**, not KYC/identity.

### Project NANDA — Best Prava Adapter for Nanda Town
A reliable, reusable **Prava `Payments` adapter** for `nest-core` (`quote / pay / verify_payment / refund`), registered via entry points (`nest.plugins.payments → prava`) and selectable with `layers: { payments: prava }`. Shipped as `examples/prava-payments/` in the Nanda Town repo.
- **Scenario + test + failure case + adversarial validator:** `scenarios/prava_marketplace.yaml`, `tests/test_prava_payments.py` (**8 passing**), a **Senso trust gate** that raises `TrustRefusedError` for an unverified seller → refund path, and `validator.py` — an adversarial validator that FAILS a trace which settled to an unverified payee (what `prepaid_credits` does) and PASSES the gated `prava` trace.
- Evidence: `python demo.py` prints settlement `CONFIRMED` → scammer `BLOCKED` → `REFUNDED`; `python simulate_failure.py` writes a Nanda trace where `nest inspect` shows a first-class **`trust_refused`** event; **the repo's own `make ci-local` (ruff + pyright + pytest) passes**.
- **PR (opened):** https://github.com/projnanda/nandatown/pull/212

### Localhost — Most Startup‑Ready Product
Live **landing + waitlist funnel** (Supabase‑backed) → self‑serve onboarding → dashboard (with a trust‑posture panel) → buyer agent → MCP/ChatGPT connector. Distribution wedge = "paste your URL." Prava isn't a bolt‑on — **agent‑to‑agent payment is the core loop.**

## Disclosure — pre‑existing vs built during the hackathon (Jul 31 – Aug 2 2026)
- **Pre‑existing (before Jul 31):** `[confirm]` initial platform scaffold, the webcmd PrintSmith catalog adapter, and a first pass of the Nanda Town Prava plugin.
- **Built during the window:** live Prava session+mandate integration and **headless agent‑to‑agent charge**; **Senso** ingest + grounded verify + trust‑gate; NANDA‑compatible AgentFacts + one‑click certify; buyer‑agent candidate selection + store‑order fulfillment; dashboard trust panel; landing/waitlist + Supabase; MCP connector. `[trim to what's true for you]`

## What worked / what didn't / what I learned
- **Worked:** real headless Prava mandate charge; Senso grounded verification actually gating the payment; the NANDA adapter + failure/refund case; one‑click Verify & Certify.
- **Didn't:** Prava sandbox intermittently failed cryptogram minting (`FETCH_AGENTIC_CREDS_ERROR`) on some fresh mandates; Prava's card surface blocks automated browsers (passkey needs real Chrome + Touch ID); Senso ingest is async (a few seconds of embedding lag); a persistent Node server doesn't map cleanly to Vercel serverless.
- **Learned:** agentic commerce only works when **discovery + trust + payment** ship together; grounded context (Senso) is a natural trust gate for a payment rail; NANDA's AgentFacts is a clean interop artifact; recurring mandates enforce per‑cycle guardrails you must design around.

## Demo video & screenshots
- Video (~2 min): see `VIDEO_SCRIPT.md`. Show URL → onboard → Verify & Certify → buyer buys headless via Prava → simulate‑untrusted refusal.
- **Cover image (first screenshot):** the Trust & Certify view (or the dashboard trust panel). Ready‑made at repo root: **`submission-cover-senso.png`** (Senso Verified 100/100) and `submission-cover-top.png`.
- Also attach: the Prava order (settled), and the `nest run` / `demo.py` trace for the NANDA track.

## Pre‑submit checklist
- [ ] Demo video + screenshots (cover = trust/dashboard)
- [ ] Repo judge‑accessible: https://github.com/karthikbalajikb/vendable
- [x] **NANDA PR** opened to `projnanda/nandatown` and linked → https://github.com/projnanda/nandatown/pull/212
- [ ] "Technologies used" lists **Prava**, **Senso**, **Nanda Town**
- [ ] Tracks: **Localhost**, **Senso**, **Project NANDA**
- [ ] Disclosure paragraph confirmed against the Jul 31–Aug 2 window
