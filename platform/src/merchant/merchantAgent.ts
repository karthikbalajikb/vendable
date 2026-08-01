import type { AgentCommerceManifest, CatalogItem, Receipt, ScopedToken } from '../types.js';
import { PravaClient } from '../prava/pravaClient.js';
import { WebcmdClient } from '../webcmd/webcmdClient.js';

/**
 * The onboarded store, rendered as an agent. The Merchant Agent runs the webcmd
 * commands to operate the real (no-API) store and holds the Prava merchant side.
 * Buyers call getCatalog()/placeOrder(); they never touch webcmd.
 */
export class MerchantAgent {
  constructor(
    private manifest: AgentCommerceManifest,
    private prava: PravaClient = new PravaClient(),
    private webcmd: WebcmdClient = new WebcmdClient(),
  ) {}

  getCatalog(): CatalogItem[] {
    return this.manifest.capabilities.catalog;
  }

  /** Buyer submits an order + a scoped token. Merchant drives checkout + settles via Prava. */
  async placeOrder(
    sku: string,
    token: ScopedToken,
    opts: { variant?: string; qty?: number } = {},
  ): Promise<Receipt> {
    const item = this.getCatalog().find((i) => i.sku === sku);
    if (!item) throw new Error(`unknown sku: ${sku}`);
    const adapter = this.manifest.capabilities.adapter ?? 'printsmith';
    // Merchant drives the real (no-API) store checkout via the compiled webcmd command,
    // then settles the buyer's Prava scoped token (sandbox/mock).
    const order = await this.webcmd.checkout(adapter, { sku, variant: opts.variant, qty: opts.qty });
    return this.prava.pay(token, order.orderRef, {
      merchantName: this.manifest.displayName,
      merchantUrl: this.manifest.storeUrl ?? `https://${this.manifest.displayName}`,
      amount: item.price,
      currency: item.currency,
      items: [{ description: item.title, unitPrice: item.price, quantity: opts.qty ?? 1, productId: item.sku }],
      description: `Vendable order: ${item.title}`,
    });
  }
}
