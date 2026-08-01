# nanda — Prava payments plugin for Nanda Town

The Day-2 deliverable: a reusable **Prava payments-layer plugin** for
[Nanda Town](https://github.com/projnanda/nandatown), plus a scenario where a buyer
swarm transacts with the onboarded PrintSmith merchant and a **Senso trust gate**
refuses an unverified agent (the required failure case).

## Install

```bash
cd nanda
uv venv --python 3.12
source .venv/bin/activate
uv pip install "nest-core[plugins]"   # Nanda Town engine + reference plugins + CLI
uv pip install -e .                   # this plugin (registers payments: prava)
nest doctor                           # expect 7/7 checks passed
nest plugins list                     # 'prava' should appear under payments
```

## Run

```bash
python demo.py                                   # settlement + trust refusal + refund via the Nanda registry
nest run scenarios/printsmith_marketplace.yaml   # runs the 24-agent scenario on payments: prava
pytest -q                                        # 6 tests: success paths + trust-gate failure
```

`demo.py` resolves the plugin the same way the simulator does
(`PluginRegistry.resolve("payments", "prava")`) and prints:

```
resolved payments plugin -> prava_payments.plugin.PravaPayments
[OK]      did:buyer:alice -> did:printsmith:store
          399 INR  status=CONFIRMED   balances: buyer=601 merchant=399
[BLOCKED] Payee did:unknown:scammer failed Senso verification; Prava token refused
[REFUND]  status=REFUNDED             balances: buyer=1000 merchant=0
```

## What it proves

- **≥1 successful settlement** — buyer pays PrintSmith over Prava, `PaymentStatus.CONFIRMED`.
- **≥1 handled failure** — the Senso trust gate refuses an unverified seller (`TrustRefused`).
- **Refund path** — `refund()` reverses the ledger and reports `PaymentStatus.REFUNDED`.
- **Registered plugin** — `nest plugins list` shows `prava` under `payments` (entry-point discovery).

## Layout

- `prava_payments/plugin.py` — the `Payments` implementation (quote / pay / verify_payment / refund)
- `prava_payments/prava_client.py` — HTTP client to the Prava sandbox (offline mock fallback)
- `prava_payments/trust.py` — Senso trust gate used inside `pay()`
- `scenarios/printsmith_marketplace.yaml` — the scenario (uses `payments: prava`)
- `demo.py` — resolves the plugin via the Nanda registry and runs a live settlement
- `tests/test_prava_payments.py` — success paths + the trust-gate failure case

## Going live against the real sandbox

The `PravaClient` runs in an offline mock by default so the sim is deterministic.
To settle against the real sandbox, set `PRAVA_API_KEY` and `PRAVA_LIVE=1`
(confirm endpoint paths in [docs.prava.space](https://docs.prava.space) first).

> Note: the plugin is written against the real `nest_sdk` types — install `nest-core`
> first (above) so the exact `Quote`/`Receipt`/`PaymentStatus` constructors are correct.
