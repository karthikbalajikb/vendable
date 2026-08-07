# Vendable — 2‑minute demo video script

Target: ~2:00. Voiceover (VO) + what's on screen. Record the app at `localhost:4000/app` in **Chrome** (Prava passkey needs a real browser). Have a **fresh Prava mandate approved** before recording so the live buy settles.

> Pre‑roll setup: server running, PrintSmith onboarded + Senso‑ingested, one fresh mandate approved (Touch ID), a store you can "simulate untrusted".

---

**0:00–0:15 — Hook + problem**
VO: "Shopping is moving from humans clicking to AI agents buying. But almost no store is ready — agents can't discover it, can't trust it, and can't pay it safely. Vendable fixes that in one paste."
Screen: landing page → paste a store URL → hit the button.

**0:15–0:35 — Onboard (discover)**
VO: "Give us a store URL — even a custom store with no API. We crawl the catalog and publish everything an agent needs: a product feed, an Agent Commerce Manifest, and a NANDA‑compatible AgentFacts card."
Screen: dashboard → the store appears with product count; briefly show the Marketplace catalog.

**0:35–1:05 — Verify & Certify (Senso track)**
VO: "Before anyone pays a merchant, we verify it. We ingest the merchant's real facts into **Senso** and ask grounded, cited questions — is it legitimate, what does it sell, how does an agent pay it. This is a grounded facts check, not KYC. Verified plus payable plus a valid manifest gets a self‑issued, NANDA‑compatible certificate."
Screen: Trust & Certify → click **Verify & Certify →** → show Manifest valid, **Senso Verified 100/100** with the cited grounded answers, then **Certified · NANDA‑compatible (self‑issued)** with the certificate id + agent‑facts link.

**1:05–1:40 — Buy headless over Prava (Prava + Localhost)**
VO: "Now an AI buyer agent shops. I ask for a BMW wall frame; it finds real products, I pick one, and it pays **headlessly over Prava** — I approved a spending mandate once with Touch ID, and the agent charges it within caps, no human in the loop. Prava returns a one‑time, merchant‑scoped card; the order lands in the store."
Screen: Buyer Agent → type "BMW wall frame" → Find products → pick one → **Buy** → receipt shows *settled · headless mandate* (+ store order if configured).

**1:40–1:55 — The trust gate (failure case + why Senso matters)**
VO: "And trust actually controls the money. If a merchant isn't Senso‑verified, the buyer agent **refuses the Prava token** — the charge never happens, and the block is captured."
Screen: switch the trust dropdown to **simulate untrusted merchant** → Buy → red **⛔ Payment blocked by the trust gate — Prava token withheld · no charge.**

**1:55–2:05 — Close (+ NANDA adapter)**
VO: "Same engine ships as a reusable **Prava payments adapter for Nanda Town** — quote, pay, verify, refund, with the trust gate as the failure case. Vendable: paste a URL, get a merchant that agents can discover, trust, and buy from."
Screen: quick cut to a terminal running `python demo.py` (CONFIRMED → BLOCKED → REFUNDED), then the Vendable logo.

---

### B‑roll to capture for screenshots / NANDA judges
- `python demo.py` output (settlement CONFIRMED → scammer BLOCKED → REFUNDED).
- `nest run scenarios/printsmith_marketplace.yaml` trace.
- The Prava dashboard order (settled) for the live charge.
- The hosted `…/.well-known/agent-facts.json` showing `self_issued: true`.

### Tips
- Keep it one continuous take per section; speak to the on‑screen action.
- If the live Prava charge flakes (sandbox `FETCH_AGENTIC_CREDS_ERROR`), use a **freshly approved mandate with an official test card** (`4622 9431 2313 7797` · CVV `640` · exp `12/27` · OTP `456789`) and retry once, or narrate the settled charge from the Prava dashboard.
- Cover image for Devfolio = the **Trust & Certify** screen mid‑"Verified 100/100".
