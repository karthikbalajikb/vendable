// UCP (Universal Commerce Protocol) client — read-only catalog access.
//
// Talks to a Shopify UCP merchant's MCP endpoint (e.g. `/api/ucp/mcp`) over
// JSON-RPC 2.0. UCP gates every call on the *calling agent's* profile: the
// merchant fetches the agent-profile URL we present in
// `params.arguments.meta['ucp-agent'].profile` before it will serve catalog or
// checkout. That agent profile is exactly the identity/trust artifact Vendable
// mints — for now we present the canonical hosted default so we can read live
// catalogs; later this points at a Vendable-hosted agent profile.

import { randomUUID } from 'node:crypto';
import type { CatalogItem } from '../types.js';

// Canonical, publicly-hosted UCP agent profile (valid, advertises shopping
// capabilities). Override with UCP_AGENT_PROFILE_URL. Read at call time because
// dotenv loads after module imports run.
const DEFAULT_PROFILE_URL =
  'https://shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json';

function agentProfileUrl(override?: string): string {
  return override || process.env.UCP_AGENT_PROFILE_URL || DEFAULT_PROFILE_URL;
}

interface UcpMoney {
  amount: number;
  currency: string;
}
interface UcpMedia {
  type?: string;
  url?: string;
}
interface UcpVariant {
  id?: string;
  sku?: string;
  title?: string;
  price?: UcpMoney;
  availability?: { available?: boolean };
  checkout_url?: string;
  media?: UcpMedia[];
}
interface UcpProduct {
  id?: string;
  title?: string;
  url?: string;
  handle?: string;
  price_range?: { min?: UcpMoney; max?: UcpMoney };
  variants?: UcpVariant[];
  media?: UcpMedia[];
}
interface UcpSearchEnvelope {
  products?: UcpProduct[];
  pagination?: { has_next_page?: boolean; cursor?: string };
}
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: { content?: { type?: string; text?: string }[] };
  error?: { code: number; message: string; data?: { content?: string } };
}

export interface UcpCatalogResult {
  endpoint: string;
  query: string;
  products: CatalogItem[];
  hasNextPage: boolean;
  cursor?: string;
}

export interface UcpSearchOptions {
  profileUrl?: string;
  limit?: number;
  toolName?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// UCP prices are minor units (99900 => 999.00).
function money(m?: UcpMoney): { price: number; currency: string } {
  if (!m || typeof m.amount !== 'number') return { price: 0, currency: 'USD' };
  return { price: Math.round(m.amount) / 100, currency: m.currency || 'USD' };
}

function firstImage(p: UcpProduct): string | undefined {
  const fromProduct = (p.media ?? []).find((m) => (m.type ?? 'image') === 'image' && m.url);
  if (fromProduct?.url) return fromProduct.url;
  return (p.variants ?? []).flatMap((v) => v.media ?? []).find((m) => m.url)?.url;
}

/** Map a UCP product to Vendable's CatalogItem. */
export function ucpProductToCatalogItem(p: UcpProduct): CatalogItem {
  const v0 = (p.variants ?? [])[0];
  const priced = money(p.price_range?.min ?? v0?.price);
  return {
    sku: String(v0?.sku || p.handle || p.id || p.title || '').trim(),
    title: String(p.title ?? v0?.title ?? 'Untitled').trim(),
    price: priced.price,
    currency: priced.currency,
    variants: (p.variants ?? [])
      .map((v) => (v.title ?? '').trim())
      .filter((t) => t.length > 0)
      .slice(0, 12),
    url: p.url || v0?.checkout_url,
    image: firstImage(p),
  };
}

/**
 * Search a UCP merchant catalog. `endpoint` is the merchant's MCP endpoint
 * (e.g. https://shop.myshopify.com/api/ucp/mcp).
 */
export async function ucpSearchCatalog(
  endpoint: string,
  query: string,
  opts: UcpSearchOptions = {},
): Promise<UcpCatalogResult> {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);
  const env = (await callUcpTool(
    endpoint,
    opts.toolName ?? 'search_catalog',
    { catalog: { query, pagination: { limit } } },
    { profileUrl: opts.profileUrl, timeoutMs: opts.timeoutMs },
  )) as UcpSearchEnvelope;
  return {
    endpoint,
    query,
    products: (env.products ?? []).map(ucpProductToCatalogItem),
    hasNextPage: env.pagination?.has_next_page ?? false,
    cursor: env.pagination?.cursor,
  };
}

export interface UcpToolOptions {
  profileUrl?: string;
  timeoutMs?: number;
}

/** POST a JSON-RPC `tools/call` with our agent profile; return the tool payload. */
async function callUcpTool(
  endpoint: string,
  toolName: string,
  argsBody: Record<string, unknown>,
  opts: UcpToolOptions = {},
): Promise<Record<string, unknown>> {
  const profile = agentProfileUrl(opts.profileUrl);
  const rpc = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: {
        meta: { 'ucp-agent': { profile }, 'idempotency-key': randomUUID() },
        ...argsBody,
      },
    },
  };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(rpc),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`UCP request failed: ${(e as Error).message}`);
  }

  const text = await res.text();
  let parsed: JsonRpcResponse;
  try {
    parsed = JSON.parse(text) as JsonRpcResponse;
  } catch {
    throw new Error(`UCP endpoint returned non-JSON (HTTP ${res.status}): ${text.slice(0, 180)}`);
  }
  if (parsed.error) {
    const extra = parsed.error.data?.content ? ` — ${parsed.error.data.content}` : '';
    throw new Error(`UCP error ${parsed.error.code}: ${parsed.error.message}${extra}`);
  }
  const payloadText = parsed.result?.content?.find((c) => c.text)?.text;
  if (!payloadText) throw new Error('UCP response carried no content payload');
  try {
    return JSON.parse(payloadText) as Record<string, unknown>;
  } catch {
    throw new Error('UCP tool payload was not valid JSON');
  }
}

// ─── Buy flow: find a buyable variant, build a real cart + checkout ──────────

export interface UcpPick {
  variantId: string;
  title: string;
  price: number;
  currency: string;
  url?: string;
  image?: string;
}

/** Search and return the first *available* buyable variant (with its GID). */
export async function ucpFirstBuyable(
  endpoint: string,
  query: string,
  opts: UcpToolOptions = {},
): Promise<UcpPick | undefined> {
  const env = (await callUcpTool(
    endpoint,
    'search_catalog',
    { catalog: { query, pagination: { limit: 10 } } },
    opts,
  )) as UcpSearchEnvelope;
  const products = env.products ?? [];
  const toPick = (product: UcpProduct, v: UcpVariant): UcpPick => {
    const priced = money(v.price ?? product.price_range?.min);
    return {
      variantId: String(v.id ?? ''),
      title: String(product.title ?? v.title ?? 'Untitled'),
      price: priced.price,
      currency: priced.currency,
      url: product.url || v.checkout_url,
      image: firstImage(product),
    };
  };
  // Prefer the first in-stock variant across the results.
  for (const product of products) {
    const available = (product.variants ?? []).find((v) => v.availability?.available === true && v.id);
    if (available) return toPick(product, available);
  }
  // Fallback: first product's first variant (may be out of stock).
  const p0 = products[0];
  const v0 = (p0?.variants ?? [])[0];
  if (!p0 || !v0?.id) return undefined;
  return toPick(p0, v0);
}

export interface UcpTotals {
  subtotal: number;
  total: number;
  currency: string;
  lines: { type: string; amount: number }[];
}
export interface UcpCart extends UcpTotals {
  id: string;
  continueUrl?: string;
}
export interface UcpCheckout extends UcpCart {
  status?: string;
}
export interface UcpLineInput {
  variantId: string;
  quantity?: number;
}

interface UcpTotalLine {
  type?: string;
  amount?: number;
}
function totalsFrom(env: Record<string, unknown>): UcpTotals {
  const lines = Array.isArray(env.totals) ? (env.totals as UcpTotalLine[]) : [];
  const pick = (t: string): number => {
    const line = lines.find((x) => x.type === t);
    return line && typeof line.amount === 'number' ? Math.round(line.amount) / 100 : 0;
  };
  return {
    subtotal: pick('subtotal'),
    total: pick('total') || pick('subtotal'),
    currency: typeof env.currency === 'string' ? env.currency : 'USD',
    lines: lines.map((l) => ({ type: String(l.type ?? ''), amount: Math.round(Number(l.amount ?? 0)) / 100 })),
  };
}

/** Create a real cart at a UCP merchant (pre-payment; no order is placed). */
export async function ucpCreateCart(
  endpoint: string,
  items: UcpLineInput[],
  opts: UcpToolOptions & { country?: string } = {},
): Promise<UcpCart> {
  const env = await callUcpTool(
    endpoint,
    'create_cart',
    {
      cart: {
        line_items: items.map((i) => ({ item: { id: i.variantId }, quantity: i.quantity ?? 1 })),
        context: { address_country: opts.country ?? 'US' },
      },
    },
    opts,
  );
  return {
    id: String(env.id ?? ''),
    continueUrl: typeof env.continue_url === 'string' ? env.continue_url : undefined,
    ...totalsFrom(env),
  };
}

/**
 * Create a real checkout (pre-payment; no order is placed). Prefer cart
 * conversion via `cartId`. `complete_checkout` (which places the order) is
 * intentionally never called — settlement is the merchant's own payment handler.
 */
export async function ucpCreateCheckout(
  endpoint: string,
  args: { cartId?: string; items?: UcpLineInput[] },
  opts: UcpToolOptions = {},
): Promise<UcpCheckout> {
  const checkout: Record<string, unknown> = {
    line_items: (args.items ?? []).map((i) => ({ item: { id: i.variantId }, quantity: i.quantity ?? 1 })),
  };
  if (args.cartId) checkout.cart_id = args.cartId;
  const env = await callUcpTool(endpoint, 'create_checkout', { checkout }, opts);
  return {
    id: String(env.id ?? ''),
    status: typeof env.status === 'string' ? env.status : undefined,
    continueUrl: typeof env.continue_url === 'string' ? env.continue_url : undefined,
    ...totalsFrom(env),
  };
}

interface UcpWellKnown {
  ucp?: { services?: Record<string, { transport?: string; endpoint?: string }[]> };
}

/**
 * Resolve a merchant's UCP MCP endpoint. Accepts either the MCP endpoint itself
 * (…/api/ucp/mcp) or a store origin, in which case we read `/.well-known/ucp`
 * and pick the `dev.ucp.shopping` MCP transport.
 */
export async function resolveUcpEndpoint(input: string, timeoutMs = 12_000): Promise<string> {
  const u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  if (/\/mcp\/?$/.test(u.pathname) || u.pathname.includes('/api/ucp/mcp')) {
    return u.toString();
  }
  const wellKnown = new URL('/.well-known/ucp', u.origin).toString();
  const res = await fetch(wellKnown, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`no UCP discovery at ${wellKnown} (HTTP ${res.status})`);
  const data = (await res.json()) as UcpWellKnown;
  const shopping = data.ucp?.services?.['dev.ucp.shopping'] ?? [];
  const mcp = shopping.find((s) => s.transport === 'mcp' && s.endpoint);
  if (!mcp?.endpoint) throw new Error(`no MCP transport advertised at ${wellKnown}`);
  return mcp.endpoint;
}
