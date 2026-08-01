# Vendable — Agent‑Commerce FDE

Give any e‑commerce store a **URL** → make it discoverable and **payable by AI agents**.
We use **webcmd** to operate no‑API stores cheaply, **Prava** to settle payment, and
**Nanda Town** to certify it works (including failure handling).

> Built for two hackathons (Aug 2–3, 2026), one shared core, two heroes:
> - **webcmd event (Day 1, 1‑day):** a self‑learning commerce adapter + Prava payment.
> - **Prava / NANDA event (Day 2, 2‑day):** a reusable Prava payments plugin for Nanda Town.

## Repo layout

| Path | Stack | What it is |
|------|-------|------------|
| `platform/` | Node/TS | Onboarding **dashboard** + API, webcmd crawl, Prava client, merchant + buyer agents, CLI |
| `nanda/` | Python 3.12 | Prava payments plugin for Nanda Town + scenario + tests (the Prava adapter) |
| `shared/` | JSON Schema | The **Agent Commerce Manifest** — the seam between `platform` and `nanda` |

## The flow (PrintSmith demo)

```
store URL ──► [platform] webcmd crawl + INTERCEPT ──► compiled adapter + catalog
          ──► mint identity + provision Prava ──► Agent Commerce Manifest
          ──► buyer agent buys 1 item, paid via Prava (sandbox)      (Day 1 · webcmd event)
          ──► Nanda Town twin + buyer swarm transact via Prava plugin (Day 2 · Prava event)
                └─ Senso trust gate refuses an unverified agent (required failure case)
```

Roles (important): the **Merchant Agent** (we build, wraps the store) runs the webcmd
commands. The **Buyer Agent** only calls the merchant and pays with a Prava token — it
never touches webcmd. PrintSmith's own chat "Shopkeeper" widget is unrelated.

## Setup (Phase 0)

1. **Prava sandbox** — sign up at https://dashboard.prava.space, create a sandbox app,
   copy keys into `.env` (see `.env.example`). Confirm the API base URL from
   https://docs.prava.space.
2. **webcmd** — `npm install -g @agentrhq/webcmd` then `webcmd skills add`.
3. **Platform** — `cd platform && npm install`.
4. **Nanda** — `cd nanda && uv venv --python 3.12 && source .venv/bin/activate && uv pip install "nest-core[plugins]" && uv pip install -e .`
5. Copy `.env.example` → `.env` and fill in keys.

## Run

- **Dashboard (web):** `cd platform && npm run serve` → http://localhost:4000 — enter a store
  URL and watch it become vendable (add `WEBCMD_LIVE=1` for a real crawl).
- Onboard via CLI:  `cd platform && npm run onboard -- https://theprintsmithstore.com/`
- Buy as an agent:  `cd platform && npm run buy -- "buy the Dark Knight poster under 500"`
- webcmd surface:   `cd platform && npm run commands`  ·  cost curve: `npm run bench`
- Certify in Nanda: `cd nanda && source .venv/bin/activate && python demo.py`
  (or the full swarm: `nest run scenarios/printsmith_marketplace.yaml`)

## Status

`nanda/` (Day-2 Prava plugin) is **complete and verified**: `payments: prava` registers,
`demo.py` settles + refuses an unverified agent + refunds, `pytest` passes 6 tests.
`platform/` is a **self-serve dashboard** (`npm run serve`): enter a URL → it detects the
platform, crawls the catalog (generic Shopify `products.json` **or** an authored webcmd
adapter), mints an agent identity, provisions Prava, stores the manifest, and lets an AI
buyer purchase. Verified live on theprintsmithstore.com (60 products, authored webcmd
adapter) and allbirds.com (250 products, Shopify). Flip `WEBCMD_LIVE=1` / add Prava keys
to go fully live (see `SETUP.md`).

See `SETUP.md` for the Phase-0 checklist and `/memories/session/plan.md` (agent working
notes) for the full two-day plan, decisions, and roadmap.
