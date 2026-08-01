import { randomUUID } from 'node:crypto';
import type { Receipt, ScopedToken } from '../types.js';

export interface PravaSession {
  sessionId: string;
  sessionToken: string;
  iframeUrl: string;
  orderId: string;
  expiresAt: string;
  authorizeOnly?: boolean;
}

export interface OrderContext {
  merchantName: string;
  merchantUrl: string;
  countryIso2?: string;
  amount: number;
  currency: string;
  items: { description: string; unitPrice: number; quantity?: number; productId?: string }[];
  description?: string;
}

/**
 * Client for the Prava payment rail (session-based API — https://docs.prava.space).
 *
 * Real flow: POST /v1/sessions (pin the order) -> the owner approves card + passkey on
 * the returned iframe_url -> GET /v1/sessions/{id}/payment-result (one-time card token +
 * dynamic CVV) -> POST report-status. Headless agent charges use a mandate (approved once).
 *
 * MOCK by default so the demo runs offline. Set PRAVA_API_KEY + PRAVA_LIVE=1 to make real
 * sandbox calls (adding a key alone will NOT break the mock demo).
 */
export class PravaClient {
  private apiKey = process.env.PRAVA_SECRET_KEY ?? process.env.PRAVA_API_KEY ?? '';
  private baseUrl = (process.env.PRAVA_BASE_URL ?? 'https://sandbox.api.prava.space').replace(/\/$/, '');
  readonly live = !!this.apiKey && process.env.PRAVA_LIVE === '1';
  private get mock(): boolean {
    return !this.live;
  }

  constructor() {
    if (!this.live) console.warn('[prava] MOCK mode (set PRAVA_API_KEY + PRAVA_LIVE=1 for real Prava calls)');
  }

  private async req(method: string, apiPath: string, body?: unknown): Promise<Record<string, any>> {
    const res = await fetch(this.baseUrl + apiPath, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      const e = (json.error ?? {}) as { code?: string; message?: string };
      throw new Error(`Prava ${res.status} ${e.code ?? ''}: ${e.message ?? 'request failed'}`.trim());
    }
    return json;
  }

  /** Create a REAL Prava session (POST /v1/sessions) → checkout/approval surface. */
  async createSession(order: OrderContext, opts: { userId?: string; userEmail?: string } = {}): Promise<PravaSession> {
    const body = {
      user_id: opts.userId ?? process.env.PRAVA_USER_ID ?? 'vendable-demo',
      user_email: opts.userEmail ?? process.env.PRAVA_USER_EMAIL ?? 'demo@vendable.dev',
      total_amount: order.amount.toFixed(2),
      currency: order.currency,
      purchase_context: [
        {
          merchant_details: {
            name: order.merchantName,
            url: order.merchantUrl.startsWith('http') ? order.merchantUrl : `https://${order.merchantUrl}`,
            country_code_iso2: order.countryIso2 ?? 'US',
          },
          product_details: order.items.map((i) => ({
            description: i.description,
            unit_price: i.unitPrice.toFixed(2),
            quantity: i.quantity ?? 1,
            ...(i.productId ? { product_id: i.productId.slice(0, 50) } : {}),
          })),
        },
      ],
      integration_type: 'full_checkout',
      description: order.description,
    };
    const j = await this.req('POST', '/v1/sessions', body);
    return {
      sessionId: j.session_id,
      sessionToken: j.session_token,
      iframeUrl: j.iframe_url,
      orderId: j.order_id,
      expiresAt: j.expires_at,
      authorizeOnly: j.authorizeOnly,
    };
  }

  /** Poll a session for the payment result (GET /v1/sessions/{id}/payment-result). */
  async getPaymentResult(sessionId: string): Promise<Record<string, any>> {
    return this.req('GET', `/v1/sessions/${encodeURIComponent(sessionId)}/payment-result`);
  }

  /** Report the merchant-side outcome (POST /v1/sessions/{id}/report-status). */
  async reportStatus(sessionId: string, txnRefId: string, status: 'APPROVED' | 'DECLINED'): Promise<Record<string, any>> {
    return this.req('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/report-status`, { txn_ref_id: txnRefId, status });
  }

  /** Set up a spending mandate (Create Session + mandate_setup) — approve ONCE via passkey, then charge headlessly. */
  async createMandate(order: OrderContext, opts: { maxCharges?: number; frequency?: 'one_time' | 'weekly' | 'monthly' | 'yearly'; userId?: string; userEmail?: string } = {}): Promise<PravaSession> {
    const body = {
      user_id: opts.userId ?? process.env.PRAVA_USER_ID ?? 'vendable-demo',
      user_email: opts.userEmail ?? process.env.PRAVA_USER_EMAIL ?? 'demo@vendable.dev',
      total_amount: order.amount.toFixed(2),
      currency: order.currency,
      purchase_context: [
        {
          merchant_details: {
            name: order.merchantName,
            url: order.merchantUrl.startsWith('http') ? order.merchantUrl : `https://${order.merchantUrl}`,
            country_code_iso2: order.countryIso2 ?? 'US',
          },
          product_details: order.items.map((i) => ({ description: i.description, unit_price: i.unitPrice.toFixed(2), quantity: i.quantity ?? 1 })),
        },
      ],
      integration_type: 'full_checkout',
      mandate_setup: { intent: 'mandate_setup', recurring_frequency: opts.frequency ?? 'monthly', merchant_scope: 'listed', max_charges: opts.maxCharges ?? 10 },
    };
    const j = await this.req('POST', '/v1/sessions', body);
    return { sessionId: j.session_id, sessionToken: j.session_token, iframeUrl: j.iframe_url, orderId: j.order_id, expiresAt: j.expires_at, authorizeOnly: j.authorizeOnly };
  }

  /** List mandates (GET /v1/mandates). */
  async listMandates(): Promise<Array<Record<string, any>>> {
    const j = await this.req('GET', '/v1/mandates');
    return (j.mandates ?? j.data ?? (Array.isArray(j) ? j : [])) as Array<Record<string, any>>;
  }

  /** Charge an active mandate headlessly (POST /v1/mandates/{id}/charge) — NO passkey. */
  async chargeMandate(
    mandateId: string,
    amount: number,
    opts: { reference?: string; purchaseContext?: OrderContext } = {},
  ): Promise<Record<string, any>> {
    const body: Record<string, unknown> = { amount: amount.toFixed(2) };
    if (opts.reference) body.reference = opts.reference;
    if (opts.purchaseContext) {
      const pc = opts.purchaseContext;
      body.purchase_context = [
        {
          merchant_details: {
            name: pc.merchantName,
            url: pc.merchantUrl.startsWith('http') ? pc.merchantUrl : `https://${pc.merchantUrl}`,
            country_code_iso2: pc.countryIso2 ?? 'US',
          },
          product_details: pc.items.map((i) => ({
            description: i.description,
            unit_price: i.unitPrice.toFixed(2),
            quantity: i.quantity ?? 1,
            ...(i.productId ? { product_id: i.productId.slice(0, 50) } : {}),
          })),
        },
      ];
    }
    return this.req('POST', `/v1/mandates/${encodeURIComponent(mandateId)}/charge`, body);
  }

  // ---- compatibility surface used by the merchant / buyer agents ----

  /** Merchant reference. Prava merchants come from the API key's account, so this is a local id. */
  async provisionMerchant(displayName: string): Promise<string> {
    return `mrc_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)}`;
  }

  /** Mock scoped token. In live mode the real one-time credential comes from a session result. */
  async requestScopedToken(merchantRef: string, amount: number, currency = 'INR'): Promise<ScopedToken> {
    return { token: `tok_${randomUUID().slice(0, 8)}`, merchantRef, amount, currency, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
  }

  /** Settle. MOCK → instant settled receipt. LIVE → create a real Prava session (needs passkey approval). */
  async pay(token: ScopedToken, ref: string, order?: OrderContext): Promise<Receipt> {
    if (this.mock || !order) {
      return { ref, status: 'settled', amount: token.amount, currency: token.currency };
    }
    const session = await this.createSession(order);
    return {
      ref: session.sessionId,
      status: 'pending',
      amount: order.amount,
      currency: order.currency,
      sessionId: session.sessionId,
      iframeUrl: session.iframeUrl,
    };
  }

  async verify(ref: string): Promise<Receipt['status']> {
    if (this.mock) return 'settled';
    const r = await this.getPaymentResult(ref);
    return r.status === 'completed' ? 'settled' : r.status === 'failed' ? 'failed' : 'pending';
  }

  async refund(_ref: string): Promise<void> {
    // Prava refunds are handled via report-status / mandate flows; no-op in the demo.
    return;
  }
}
