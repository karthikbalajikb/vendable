// Minimal Prava client for the Vercel MCP function — mirrors platform/src/prava/pravaClient.ts
// + the payment leg of platform/src/checkout/purchase.ts, kept self-contained so the Vercel
// deploy needs no imports from platform/. Env: PRAVA_SECRET_KEY|PRAVA_API_KEY, PRAVA_BASE_URL,
// PRAVA_LIVE (set these in the Vercel project's Environment Variables).

const KEY = process.env.PRAVA_SECRET_KEY || process.env.PRAVA_API_KEY || '';
const BASE = (process.env.PRAVA_BASE_URL || 'https://sandbox.api.prava.space').replace(/\/$/, '');
export const pravaLive = !!KEY && process.env.PRAVA_LIVE === '1';

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json.error || {};
    throw new Error(`Prava ${res.status} ${e.code || ''}: ${e.message || 'request failed'}`.trim());
  }
  return json;
}

async function listMandates() {
  const j = await req('GET', '/v1/mandates');
  return j.mandates || j.data || (Array.isArray(j) ? j : []);
}

/** Prava purchase context naming the merchant + the real product (with link). */
function chargeContextFor(rec, item, merchantName) {
  const link = item.url || rec.url;
  const url = String(rec.manifest?.storeUrl || rec.url || '');
  return {
    merchant_details: {
      name: merchantName,
      url: url.startsWith('http') ? url : `https://${url}`,
      country_code_iso2: 'US',
    },
    product_details: [
      { description: `${item.title} — ${link}`, unit_price: Number(item.price).toFixed(2), quantity: 1, product_id: String(item.sku).slice(0, 50) },
    ],
  };
}

async function chargeMandate(mandateId, amount, { reference, purchaseContext }) {
  const body = { amount: Number(amount).toFixed(2) };
  if (reference) body.reference = reference;
  if (purchaseContext) body.purchase_context = [purchaseContext];
  return req('POST', `/v1/mandates/${encodeURIComponent(mandateId)}/charge`, body);
}

/**
 * Payment leg: charge the most-recently-created active mandate with enough budget headlessly.
 * Mirrors purchase() in the platform. In MOCK mode (no live key) returns a settled receipt.
 */
export async function settle(rec, item) {
  if (!pravaLive) {
    return { ok: true, headless: false, receipt: { ref: `mock_${Date.now().toString(36)}`, status: 'settled', amount: item.price, currency: item.currency } };
  }
  // Prava allows ONE charge per cycle per mandate — prefer one untouched this cycle
  // (remaining == approvedAmount), newest first; a spent one would decline "already this cycle".
  const liveMandates = (await listMandates().catch(() => [])).filter((m) => String(m.status || '').toLowerCase() === 'active');
  const active = liveMandates
    .filter((m) => Number(m.remaining || 0) >= item.price && Number(m.remaining || 0) >= Number(m.approvedAmount || m.remaining || 0))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
  if (!active) {
    const error = liveMandates.length
      ? 'All approved Prava mandates were already used this cycle (one purchase per cycle per mandate). Approve a fresh mandate to buy again.'
      : 'No active Prava mandate — approve one first.';
    return { ok: false, headless: liveMandates.length > 0, receipt: { ref: '', status: 'failed', amount: item.price, currency: item.currency }, error };
  }
  const mandateId = String(active.id || active.mandate_id || active.mandateId);
  const merchantName = String(active.merchantName || rec.manifest?.displayName || rec.id);
  const charge = await chargeMandate(mandateId, item.price, {
    reference: `${rec.id}-${item.sku}-${Date.now()}`,
    purchaseContext: chargeContextFor(rec, item, merchantName),
  });
  const settled = charge.status === 'awaiting_result' || charge.fetchStatus === 'SUCCESS';
  return {
    ok: settled,
    headless: true,
    mandate: mandateId,
    receipt: { ref: String(charge.transactionId || ''), status: settled ? 'settled' : 'failed', amount: item.price, currency: item.currency },
    error: charge.errorMessage ? String(charge.errorMessage) : undefined,
  };
}

/** Create a Prava spending mandate (Create Session + mandate_setup). Returns the approval URL. */
export async function createMandate({ merchantName, merchantUrl, cap, currency, maxCharges }) {
  const url = String(merchantUrl || '');
  const body = {
    user_id: process.env.PRAVA_USER_ID || 'vendable-demo',
    user_email: process.env.PRAVA_USER_EMAIL || 'demo@vendable.dev',
    total_amount: Number(cap).toFixed(2),
    currency,
    purchase_context: [
      {
        merchant_details: { name: merchantName, url: url.startsWith('http') ? url : `https://${url}`, country_code_iso2: 'US' },
        product_details: [{ description: `Agent spending mandate for ${merchantName}`, unit_price: Number(cap).toFixed(2), quantity: 1 }],
      },
    ],
    integration_type: 'full_checkout',
    mandate_setup: { intent: 'mandate_setup', recurring_frequency: 'monthly', merchant_scope: 'listed', max_charges: maxCharges || 10 },
  };
  const j = await req('POST', '/v1/sessions', body);
  return { approvalUrl: j.iframe_url, sessionId: j.session_id, cap: Number(cap), currency };
}
