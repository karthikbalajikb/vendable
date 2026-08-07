# PR: Prava payments adapter for Nanda Town

> For the **NandaHack × Prava — Best Prava Adapter for NANDA Town** track.
> Target repo: https://github.com/projnanda/nandatown · Track: https://nandatown.projectnanda.org/pravahack

---

## Suggested PR title
`feat(payments): Prava agentic-payments adapter + marketplace scenario + trust-gate failure case`

## PR description (paste as the PR body)

### What this adds
A reliable, reusable **Prava** implementation of the Nanda Town **payments** layer, plus a scenario, a test, and a real failure case.

- **Plugin** — `prava_payments/plugin.py` implements the `Payments` protocol: `quote()`, `pay()`, `verify_payment()`, `refund()`. Registered via entry points so any scenario can select it:
  ```toml
  [project.entry-points."nest.plugins.payments"]
  prava = "prava_payments.plugin:PravaPayments"
  ```
  ```yaml
  # in a scenario
  layers: { payments: prava }
  ```
- **Prava sandbox client** — `prava_payments/prava_client.py` talks to Prava's Agentic Payments Sandbox, with an offline mock fallback so the sim stays deterministic in CI.
- **Trust gate (failure handling)** — `prava_payments/trust.py`: a Senso‑backed gate used inside `pay()`. An unverified counterparty raises `TrustRefused` and the Prava token is withheld — the required failure case.
- **Scenario** — `scenarios/printsmith_marketplace.yaml`: a buyer swarm transacts with an onboarded PrintSmith merchant over `payments: prava`.
- **Test** — `tests/test_prava_payments.py`: success paths + the trust‑gate failure + refund.
- **README** — install + reuse instructions.

### What it proves (evaluation criteria)
- **≥1 successful sandbox transaction** — buyer pays the merchant over Prava → `PaymentStatus.CONFIRMED`.
- **≥1 handled failure** — Senso trust gate refuses an unverified seller (`TrustRefused`); Prava token not issued.
- **Refund path** — `refund()` reverses the ledger → `PaymentStatus.REFUNDED`.
- **Visible in Nanda's tooling** — `simulate_failure.py` writes a Nanda trace where the refusal is a first-class **`trust_refused`** event; `nest inspect` / `nest dashboard` show it alongside `payment_confirmed` and `refunded`.
- **Reuse** — drop‑in payments layer; any scenario flips to it with one YAML line.

### Run it
```bash
pip install "nest-core[plugins]"
pip install -e .            # registers payments: prava
nest doctor                 # 7/7
python demo.py              # settlement CONFIRMED -> scammer BLOCKED -> REFUNDED
pytest -q                   # success paths + trust-gate failure
nest run scenarios/printsmith_marketplace.yaml
python simulate_failure.py                  # writes a Nanda trace of the flow
nest inspect traces/prava_failure.jsonl     # breakdown shows trust_refused: 1
nest dashboard traces/prava_failure.jsonl   # interactive timeline in the browser
```

Expected `demo.py` output (verified — `pytest` shows `6 passed`):
```
resolved payments plugin -> prava_payments.plugin.PravaPayments

[OK]      did:buyer:alice -> did:printsmith:store
          399 INR  status=CONFIRMED
          balances: buyer=601  merchant=399

[BLOCKED] Payee did:unknown:scammer failed Senso verification; Prava token refused

[REFUND]  status=REFUNDED
          balances: buyer=1000  merchant=0
```

### Going live against the real sandbox
Set `PRAVA_API_KEY` (secret) + `PRAVA_LIVE=1`; the client then calls Prava's sandbox instead of the offline mock. `[attach a screenshot of a live sandbox txn + the scenario trace]`

### Part of a larger project
This adapter powers **Vendable** (https://github.com/karthikbalajikb/vendable), which turns any store URL into a discoverable, Senso‑verified, Prava‑payable agent. This PR is only the Nanda Town payments layer.

---

## How to actually open the PR (do this once)
The plugin currently lives in `vendable/nanda/`. To submit it to Nanda Town:

```bash
# 1. Fork projnanda/nandatown on GitHub, then:
git clone https://github.com/<you>/nandatown.git
cd nandatown
git checkout -b hackathon/prava-payments-vendable      # hackathon/* branch per the charter

# 2. Copy the adapter in (examples path keeps it out of core):
mkdir -p examples/prava-payments
cp -R "/Users/kb/Desktop/Personal/Agent Commerce/nanda/"* examples/prava-payments/

# 3. Sanity check, commit, push
cd examples/prava-payments && pip install -e . && pytest -q && cd -
git add examples/prava-payments
git commit -m "feat(payments): Prava agentic-payments adapter + scenario + trust-gate failure case"
git push -u origin hackathon/prava-payments-vendable

# 4. Open the PR to projnanda/nandatown:main, paste the description above,
#    then link the PR URL in your Devfolio submission.
```

Notes:
- Read `docs/hackathon/charter.md` in nandatown for exact branch/naming rules before pushing.
- Your PR appears in the Payments layer of the PR gallery: https://nandatown.projectnanda.org/prgallery/layers/payments
