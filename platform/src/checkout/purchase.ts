import type { StoreRecord } from '../store/storeRepo.js';
import type { CatalogItem, Receipt } from '../types.js';
import { PravaClient, type OrderContext } from '../prava/pravaClient.js';
import { checkout as simulateCheckout } from '../agent/buyerAgent.js';
import { fulfillOrder, type FulfilledOrder } from '../fulfill/fulfillment.js';

export interface PurchaseResult {
  pick: CatalogItem;
  receipt: Receipt;
  headless: boolean;
  mandate?: string;
  error?: string; // payment-leg error (e.g. Prava decline)
  storeOrder?: FulfilledOrder; // store-side fulfillment result (when configured)
  fulfillError?: string; // store-side fulfillment error (payment already settled)
}

/** Per-charge Prava purchase context — names the mandate's merchant and the real product (+ link). */
function chargeContextFor(rec: StoreRecord, item: CatalogItem, merchantName: string): OrderContext {
  const link = item.url ?? rec.url;
  return {
    merchantName,
    merchantUrl: rec.manifest.storeUrl ?? rec.url,
    countryIso2: 'US',
    amount: item.price,
    currency: item.currency,
    items: [{ description: `${item.title} — ${link}`, unitPrice: item.price, quantity: 1, productId: item.sku }],
  };
}

/**
 * Full agent checkout for a store's sku, in two legs:
 *   1. Payment — charge an approved Prava mandate HEADLESSLY (no human) when one is
 *      active; otherwise fall back to the simulated buyer checkout.
 *   2. Fulfillment — once a real payment settles, create the order in the merchant's
 *      own store (no-op unless a fulfillment endpoint is configured).
 *
 * Shared by the dashboard API, the hosted ACP endpoint, and the ChatGPT MCP connector
 * so every surface checks out identically.
 */
export async function purchase(rec: StoreRecord, sku: string): Promise<PurchaseResult> {
  const pick = rec.manifest.capabilities.catalog.find((c) => c.sku === sku);
  if (!pick) throw new Error(`unknown sku: ${sku}`);

  const prava = new PravaClient();

  // ---- payment leg ----
  // Prefer the most recently approved mandate that still has enough budget. Sorting by
  // `remaining` alone is ambiguous when several mandates share the same cap and can pick a
  // stale/broken one — recency reliably targets the mandate the user just approved.
  const active = prava.live
    ? (await prava.listMandates().catch(() => [] as Array<Record<string, any>>))
        .filter((m) => String(m.status ?? '').toLowerCase() === 'active' && Number(m.remaining ?? 0) >= pick.price)
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
    : undefined;

  let receipt: Receipt;
  let headless = false;
  let mandate: string | undefined;
  let payError: string | undefined;

  if (active) {
    mandate = String(active.id ?? active.mandate_id ?? active.mandateId);
    const merchantName = String(active.merchantName ?? rec.manifest.displayName ?? rec.id);
    const charge = await prava.chargeMandate(mandate, pick.price, {
      reference: `${rec.id}-${pick.sku}-${Date.now()}`,
      purchaseContext: chargeContextFor(rec, pick, merchantName),
    });
    const settled = charge.status === 'awaiting_result' || charge.fetchStatus === 'SUCCESS';
    headless = true;
    payError = charge.errorMessage ? String(charge.errorMessage) : undefined;
    receipt = { ref: String(charge.transactionId ?? ''), status: settled ? 'settled' : 'failed', amount: pick.price, currency: pick.currency };
  } else {
    receipt = (await simulateCheckout(rec.manifest, sku)).receipt;
  }

  const result: PurchaseResult = { pick, receipt, headless, mandate, error: payError };

  // ---- fulfillment leg (only after a real, settled Prava payment) ----
  if (headless && receipt.status === 'settled') {
    try {
      result.storeOrder = await fulfillOrder(
        rec,
        [{ sku: pick.sku, title: pick.title, quantity: 1, unitPrice: pick.price, url: pick.url }],
        { rail: 'prava', status: 'settled', transactionId: receipt.ref, mandateId: mandate, amount: pick.price, currency: pick.currency },
      );
    } catch (e) {
      result.fulfillError = (e as Error).message;
    }
  }

  return result;
}
