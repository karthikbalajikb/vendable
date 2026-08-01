# Phase 0 — Setup checklist

This lists the accounts, keys, and installs. Items marked **[you]** need a human
(signup / secrets); items marked **[done]** are already built and verified in this repo.

## Accounts & keys (only you can do these)

- [ ] **[you] Prava sandbox** — sign up at <https://dashboard.prava.space>, create a
      sandbox app, copy the API key. Confirm the API base URL + endpoint paths from
      <https://docs.prava.space> (the client marks these `TODO`).
- [ ] **[you] Senso** (optional for MVP) — key from <https://senso.ai> if you want the
      real trust gate instead of the mock allowlist.
- [ ] **[you] OpenAI / Anthropic** — key if you want the LLM-brain agents later
      (the current plugin + demo need no LLM).
- [ ] **[you]** Copy `.env.example` → `.env` and paste the keys above.

## Tooling installs

- [ ] **[you] webcmd** (Node, for onboarding no-API stores):
      `npm install -g @agentrhq/webcmd`
- [x] **[done] Node 22 / npm 10** — present.
- [x] **[done] Python 3.12 + uv + git** — present (`nanda/.venv` uses 3.12).

## Platform (Node/TS) — `platform/`

- [x] **[done]** Onboarding + buyer + merchant checkout wired through `WebcmdClient`
      (mock by default, real `webcmd` CLI when `WEBCMD_LIVE=1`).
- [ ] **[you]** `cd platform && npm install`
- [ ] Verify (mock): `npm run buy -- "buy the Dark Knight poster under 500"`
      → `Bought: The Dark Knight Rises … (INR 399)`
- [ ] Inspect the adapter surface: `npm run commands` · cost curve: `npm run bench`
- [ ] **Dashboard:** `npm run serve` → http://localhost:4000 (enter a URL to onboard a store;
      add `WEBCMD_LIVE=1` for a real crawl). Onboarded stores persist under `platform/data/`.

## Nanda (Python) — `nanda/`  ✅ complete & verified

- [x] **[done]** venv + `nest-core[plugins]` installed (`nest doctor` → 7/7).
- [x] **[done]** Prava payments plugin registered (`nest plugins list` → `prava`).
- [x] **[done]** Scenario, tests (6 passing), and registry demo all run.
- [ ] Reproduce:
      ```bash
      cd nanda && source .venv/bin/activate
      python demo.py                                   # settlement + refusal + refund
      nest run scenarios/printsmith_marketplace.yaml   # 24-agent swarm on payments: prava
      pytest -q                                        # 6 tests
      ```

## Still to build (tracked, not blockers)

- [x] **[done]** `printsmith catalog` webcmd adapter authored + verified against the live
      store (60 products, real prices). Lives at `platform/webcmd-adapters/printsmith/catalog.js`
      and `~/.webcmd/clis/printsmith/catalog.js`. Run live with `WEBCMD_LIVE=1`.
- [ ] **[you]** Author a **test-safe** `printsmith checkout` adapter (add-to-cart -> checkout,
      stop before real payment), then set `WEBCMD_CHECKOUT_LIVE=1`. Until then the buyer
      flow simulates checkout so it never places real paid orders.
- [ ] Confirm real Prava endpoints, then flip `PRAVA_LIVE=1` for a live sandbox settlement.
- [ ] (Optional) real Senso verification in `nanda/prava_payments/trust.py`.
