# Vendable — Demo Run-of-Show

> Give us your store URL → we make it an agent other AIs can **discover, trust, and buy from — payable by Prava**.

---

## Pre-flight (2 min before recording)
- `.env` (repo root): `PRAVA_LIVE=1` + `PRAVA_SECRET_KEY=sk_test_…`, `WEBCMD_LIVE=1`.
- Start server: `cd platform && PORT=4000 npm run serve` → open **http://localhost:4000** (landing) / **/app** (dashboard).
- **Use Chrome** for Prava's card page (the secure card iframe is blocked in Safari / automated browsers).
- Approve a fresh **Prava mandate** once (Buyer Agent → "1 · Set up mandate" → Chrome → test card + Touch ID). Test card: `4622 9431 2323 2499`, CVV `468`, exp `12/30`, OTP `456789`.
- Onboard `theprintsmithstore.com` (and optionally `allbirds.com`) so the Marketplace has stock.

---

## The core demo (~2.5 min, click path)

1. **Onboard (webcmd)** — Landing → **Onboard a store** → paste `https://theprintsmithstore.com/` → **Make it vendable**.
   - Narrate the pipeline: *detect platform → webcmd crawls the no-API store (60 products) → mint agent DID → provision Prava*.

2. **Readiness (the problem)** — Click the store → **Vendability = 69/C**.
   - Point at **Transactable 25%**: "It's findable, but no AI agent can actually *buy* from it."
   - Click **Apply remediation** → **94** — narrate: "Transactable is now live via our **hosted agent layer** (feed / manifest / ACP checkout). The two store-side items (Product JSON-LD, robots) are generated for you to deploy — deploy them and re-run for a true **100**." (Honest loop, not a fake score.)

3. **Marketplace (discovery + buy)** — **Marketplace** → search `porsche` → results across stores → **Buy**.
   - Receipt shows **"✅ … · headless mandate"** — a real Prava charge, no human.

4. **Agent-to-agent payment (the kicker)** — **Buyer Agent → "Agent-to-agent payments"** → **Charge headlessly**.
   - Real result: `awaiting_result · SUCCESS`, a **one-time Visa card ••••7144** minted with **no passkey**, budget **₹2000 → ₹1801**.
   - "Approve **once** with Touch ID → the agent transacts autonomously, inside a hard **₹2000/month cap** + per-cycle limit."

---

## Event framing

**webcmd event (Day 1)** — hero is the self-learning **webcmd adapter**: a no-API Next.js store becomes a CLI (`webcmd printsmith catalog -f json`). Show `npm run bench` cost curve. Payment via Prava.

**NANDA / Prava event (Day 2)** — hero is the **Prava payments plugin for Nanda Town** (quote/pay/verify/refund, 6 tests) + the **live mandate charge** (agent-to-agent). Readiness = the trust/certification story.

---

## Proof points (say these out loud)
- **Real store**: theprintsmithstore.com — custom Next.js, *no API* — onboarded live via webcmd.
- **Real Prava**: live sandbox, real Visa response, one-time card `••••7144`.
- **Honest scoring**: 69 → 94 (hosted) → 100 only after a real store deploy — no faked green.
- **Guardrails**: ₹2000/month cap + one-charge-per-cycle = safe autonomous spend.

## Fallbacks (if something hiccups on camera)
- Prava card box empty / "Pay Now" disabled → **use Chrome, disable blockers**.
- Link says **"Session Already Used"** → mint a fresh one (sessions are single-use; don't refresh).
- Mandate charge **declined "already this cycle"** → that's the guardrail; use a fresh mandate.
