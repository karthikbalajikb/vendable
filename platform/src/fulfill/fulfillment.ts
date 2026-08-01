import type { StoreRecord } from '../store/storeRepo.js';

/** One line item to fulfill in the merchant store. */
export interface FulfillItem {
  sku: string;
  title: string;
  quantity: number;
  unitPrice: number;
  url?: string;
}

/** The settled Prava payment that backs the order. */
export interface FulfillPayment {
  rail: 'prava';
  status: 'settled' | 'failed';
  transactionId?: string;
  mandateId?: string;
  amount: number;
  currency: string;
}

/** What the store's order endpoint returns. */
export interface FulfilledOrder {
  orderId: string;
  orderNumber?: string;
  status?: string;
  url?: string;
}

/**
 * Fulfillment leg: after Prava settles the agent-to-agent payment, create the real
 * order in the merchant's own store so it shows up in their admin.
 *
 * The store owner exposes one authenticated endpoint (see
 * platform/store-integration/agent-orders.route.ts for a reference handler). We POST
 * the settled order to it with a shared secret. Returns `undefined` when fulfillment
 * is not configured, so the demo still runs payment-only.
 *
 * Config:
 *   STORE_ORDER_URL      — the endpoint (or per-store manifest.fulfillmentUrl)
 *   STORE_ORDER_SECRET   — shared secret sent as `Authorization: Bearer <secret>`
 */
export async function fulfillOrder(
  rec: StoreRecord,
  items: FulfillItem[],
  payment: FulfillPayment,
  opts: { reference?: string; buyer?: { id?: string; email?: string; name?: string } } = {},
): Promise<FulfilledOrder | undefined> {
  const endpoint = rec.manifest.fulfillmentUrl ?? process.env.STORE_ORDER_URL ?? '';
  const secret = process.env.STORE_ORDER_SECRET ?? '';
  if (!endpoint || !secret) return undefined; // not configured — stay payment-only

  const amount = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const body = {
    // Idempotency key: the same reference must not create a second order (retry-safe).
    reference: opts.reference ?? payment.transactionId,
    source: 'vendable-agent',
    buyer: {
      id: opts.buyer?.id ?? process.env.PRAVA_USER_ID ?? 'vendable-agent',
      email: opts.buyer?.email ?? process.env.PRAVA_USER_EMAIL ?? 'agent@vendable.dev',
      name: opts.buyer?.name ?? 'Vendable Agent',
    },
    items: items.map((i) => ({ sku: i.sku, title: i.title, quantity: i.quantity, unit_price: i.unitPrice, url: i.url })),
    amount,
    currency: payment.currency,
    payment: {
      rail: payment.rail,
      status: payment.status,
      transaction_id: payment.transactionId,
      mandate_id: payment.mandateId,
      amount: payment.amount,
      currency: payment.currency,
    },
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    const msg = (j?.error?.message ?? j?.error ?? j?.message ?? `store returned HTTP ${res.status}`) as string;
    throw new Error(String(msg));
  }
  const o = (j.order ?? j) as Record<string, any>;
  const orderId = String(o.orderId ?? o.id ?? o.order_id ?? '');
  if (!orderId) throw new Error('store accepted the order but returned no order id');
  return {
    orderId,
    orderNumber: o.orderNumber ?? o.number ?? o.order_number ?? undefined,
    status: o.status ?? undefined,
    url: o.url ?? o.orderUrl ?? undefined,
  };
}
