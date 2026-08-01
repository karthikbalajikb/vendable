import { randomUUID } from 'node:crypto';
import type { AgentCommerceManifest, CatalogItem } from '../types.js';
import { PravaClient } from '../prava/pravaClient.js';
import { WebcmdClient } from '../webcmd/webcmdClient.js';

/** Detect the store platform by probing for a Shopify catalog endpoint. */
async function detectPlatform(url: string): Promise<AgentCommerceManifest['platform']> {
  try {
    const res = await fetch(new URL('/products.json', url));
    if (res.ok) return 'shopify';
  } catch {
    /* ignore network errors */
  }
  return 'custom';
}

/** Derive a stable webcmd adapter slug from the store hostname (theprintsmithstore.com -> printsmith). */
function deriveAdapter(hostname: string): string {
  const base = hostname.replace(/^www\./, '').split('.')[0].toLowerCase();
  const slug = base.replace(/^(the|my|shop|store)/, '').replace(/(store|shop|online|official)$/, '');
  return slug || base;
}

/** Generic Shopify catalog crawl via the public products.json (works for any Shopify store). */
async function crawlShopify(url: string): Promise<CatalogItem[]> {
  const base = url.replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/products.json?limit=250`);
    if (!res.ok) return [];
    const data = (await res.json()) as { products?: Array<Record<string, any>> };
    return (data.products ?? []).map((p) => {
      const variants = Array.isArray(p.variants) ? p.variants : [];
      const names = variants.map((v) => String(v.title)).filter((t) => t && t !== 'Default Title');
      return {
        sku: String(p.handle ?? p.id),
        title: String(p.title ?? ''),
        price: Number(variants[0]?.price ?? 0),
        currency: 'USD',
        variants: names.length ? names : undefined,
        url: `${base}/products/${p.handle}`,
        image: p.images?.[0]?.src ? String(p.images[0].src) : undefined,
      };
    });
  } catch {
    return [];
  }
}

/**
 * URL -> Agent Commerce Manifest (the handoff artifact to Nanda Town).
 *
 * Picks the crawl strategy by platform so onboarding scales across clients:
 *   - Shopify -> generic products.json (any Shopify store, real catalog)
 *   - custom  -> webcmd adapter for the derived site (live) or sample (mock)
 */
export async function onboardStore(url: string): Promise<AgentCommerceManifest> {
  const hostname = new URL(url).hostname;
  const displayName = hostname.replace(/^www\./, '');
  const adapter = deriveAdapter(hostname);

  const platform = await detectPlatform(url);

  let catalog: CatalogItem[];
  let source: string;
  if (platform === 'shopify') {
    catalog = await crawlShopify(url);
    source = 'shopify-api';
  } else {
    const webcmd = new WebcmdClient();
    catalog = await webcmd.crawlCatalog(adapter);
    source = (await webcmd.isMock()) ? 'sample' : `webcmd:${adapter}`;
  }

  const prava = new PravaClient();
  const merchantRef = await prava.provisionMerchant(displayName);

  return {
    agentId: `did:key:z${randomUUID().replace(/-/g, '')}`,
    displayName,
    storeUrl: url,
    platform,
    capabilities: { catalog, adapter, source },
    payment: { rail: 'prava', merchantRef, currency: catalog[0]?.currency ?? 'INR' },
    endpoint: `local://merchant/${displayName}`,
    trust: { attestations: [], sensoVerified: false, reputation: 0 },
  };
}
