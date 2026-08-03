// Onboard a UCP merchant as a Vendable store — catalog seeded live via UCP search.
//
// UCP has no "list all products" call; catalog search needs a query. We seed a
// representative catalog by searching a handful of category terms and de-duping,
// then build the same AgentCommerceManifest the rest of the platform consumes
// (discovery, trust panel, certify, buyer agent, MCP server).

import { randomUUID } from 'node:crypto';
import type { AgentCommerceManifest, CatalogItem } from '../types.js';
import { PravaClient } from '../prava/pravaClient.js';
import { resolveUcpEndpoint, ucpSearchCatalog } from './ucpClient.js';

const DEFAULT_SEEDS = ['bestseller', 'new', 'sale', 'gift', 'kit'];

export interface UcpOnboardInput {
  /** UCP `/api/ucp/mcp` endpoint or a store origin we discover. */
  url: string;
  /** Friendly display name (e.g. "boAt"). Defaults to the endpoint host. */
  name?: string;
  /** Friendly storefront URL (e.g. boat-lifestyle.com). */
  storeUrl?: string;
  /** Category queries to seed the catalog. */
  seeds?: string[];
  /** Products per seed query. */
  perSeed?: number;
}

/** Build an Agent Commerce Manifest for a UCP merchant, catalog seeded live via search. */
export async function onboardUcpStore(input: UcpOnboardInput): Promise<AgentCommerceManifest> {
  const endpoint = await resolveUcpEndpoint(input.url);
  const seeds = (input.seeds && input.seeds.length ? input.seeds : DEFAULT_SEEDS).slice(0, 10);
  const perSeed = Math.min(Math.max(input.perSeed ?? 5, 1), 20);

  const byKey = new Map<string, CatalogItem>();
  for (const query of seeds) {
    try {
      const { products } = await ucpSearchCatalog(endpoint, query, { limit: perSeed });
      for (const item of products) {
        const key = item.url || `${item.title}|${item.sku}`;
        if (key && !byKey.has(key)) byKey.set(key, item);
      }
    } catch {
      /* a failed seed shouldn't sink onboarding */
    }
  }
  const catalog = [...byKey.values()];

  const host = new URL(endpoint).hostname;
  const displayName = (input.name || host.replace(/^www\./, '')).trim();
  const storeUrl = input.storeUrl
    ? input.storeUrl.startsWith('http')
      ? input.storeUrl
      : `https://${input.storeUrl}`
    : `https://${host}`;

  const prava = new PravaClient();
  const merchantRef = await prava.provisionMerchant(displayName);

  return {
    agentId: `did:key:z${randomUUID().replace(/-/g, '')}`,
    displayName,
    storeUrl,
    platform: 'shopify',
    capabilities: { catalog, adapter: 'ucp', source: 'ucp' },
    payment: { rail: 'prava', merchantRef, currency: catalog[0]?.currency ?? 'INR' },
    endpoint,
    trust: { attestations: [], sensoVerified: false, reputation: 0 },
  };
}
