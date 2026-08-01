import type { StoreRecord } from '../store/storeRepo.js';
import type { AuditReport } from '../audit/audit.js';

export interface Artifact {
  checkId: string;
  title: string;
  path: string;
  language: string;
  content: string;
  hosted: boolean;
}

export interface AgentLayer {
  llmsTxt: string;
  manifestJson: string; // UCP / Agent Commerce Manifest
  acpJson: string;      // ACP capability descriptor
  feedJson: string;     // ACP product feed
  jsonld: string;       // sample schema.org Product JSON-LD
  robots: string;
}

/** Build the machine-readable "agent layer" Vendable hosts (or the client publishes) for a store. */
export function buildAgentLayer(record: StoreRecord, agentBase: string): AgentLayer {
  const m = record.manifest;
  const catalog = m.capabilities.catalog;

  const feedJson = JSON.stringify({
    version: '1.0',
    store: m.displayName,
    products: catalog.map((p) => ({
      id: p.sku,
      title: p.title,
      price: { amount: p.price, currency: p.currency },
      availability: 'in_stock',
      link: p.url ?? `${m.storeUrl ?? ''}`,
      image_link: (p as { image?: string }).image ?? undefined,
    })),
  }, null, 2);

  const manifestJson = JSON.stringify({
    protocol: 'agent-commerce/1.0',
    agentId: m.agentId,
    displayName: m.displayName,
    storeUrl: m.storeUrl,
    endpoints: {
      product_feed: `${agentBase}/feed.json`,
      acp_checkout: `${agentBase}/acp/checkout`,
      descriptor: `${agentBase}/.well-known/agentic-commerce.json`,
    },
    payment: m.payment,
    capabilities: { catalogSize: catalog.length },
    trust: m.trust,
  }, null, 2);

  const acpJson = JSON.stringify({
    acp_version: '2025-09-29',
    merchant: m.displayName,
    product_feed_url: `${agentBase}/feed.json`,
    checkout: { create_url: `${agentBase}/acp/checkout`, method: 'POST', accepts: ['sku', 'quantity'] },
    payment: { rail: 'prava', scoped_token: true },
  }, null, 2);

  const sample = catalog[0];
  const jsonld = sample
    ? JSON.stringify({
        '@context': 'https://schema.org/',
        '@type': 'Product',
        name: sample.title,
        sku: sample.sku,
        image: (sample as { image?: string }).image,
        offers: {
          '@type': 'Offer',
          price: sample.price,
          priceCurrency: sample.currency,
          availability: 'https://schema.org/InStock',
          url: sample.url,
        },
      }, null, 2)
    : '{}';

  const lines = catalog.slice(0, 20).map((p) => `- ${p.title} — ${p.currency} ${p.price}: ${p.url ?? ''}`).join('\n');
  const llmsTxt = `# ${m.displayName}\n> Agent-commerce ready via Vendable. Payable by Prava.\n\n## Machine-readable endpoints\n- Product feed (ACP): ${agentBase}/feed.json\n- Agent manifest (UCP): ${agentBase}/.well-known/agent-commerce.json\n- Checkout (ACP): ${agentBase}/acp/checkout\n\n## Products\n${lines}\n`;

  const robots = `# Allow AI answer engines\nUser-agent: GPTBot\nAllow: /\n\nUser-agent: PerplexityBot\nAllow: /\n\nUser-agent: ClaudeBot\nAllow: /\n\nUser-agent: Google-Extended\nAllow: /\n`;

  return { llmsTxt, manifestJson, acpJson, feedJson, jsonld, robots };
}

const ACP_ROUTE = `// app/api/agentic_commerce/checkout/route.ts  (Next.js App Router)
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  const { sku, quantity = 1 } = await req.json();
  // 1) look up the product  2) request a Prava scoped token (merchant+amount locked)
  //    3) settle and return the receipt to the calling agent.
  const res = await fetch('https://sandbox.prava.space/v1/payments', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.PRAVA_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ sku, quantity }),
  });
  return NextResponse.json(await res.json());
}
`;

/** Map failing/warn checks to concrete files + code the client applies (or Vendable hosts). */
export function generateRemediation(record: StoreRecord, report: AuditReport, agentBase: string): Artifact[] {
  const layer = buildAgentLayer(record, agentBase);
  const failing = new Set(report.pillars.flatMap((p) => p.checks).filter((c) => c.status !== 'pass').map((c) => c.id));
  const out: Artifact[] = [];
  const add = (checkId: string, title: string, path: string, language: string, content: string, hosted: boolean) => {
    if (failing.has(checkId)) out.push({ checkId, title, path, language, content, hosted });
  };

  // hosted:true  -> Vendable serves it live (zero-integration, no deploy needed).
  // hosted:false -> must be deployed to the store's own pages (answer engines crawl the real store).
  add('product-feed', 'Publish an ACP product feed', 'public/feed.json', 'json', layer.feedJson, true);
  add('ucp-manifest', 'Publish the Agent Commerce Manifest', 'public/.well-known/agent-commerce.json', 'json', layer.manifestJson, true);
  add('acp-checkout', 'Expose an ACP checkout endpoint', 'app/api/agentic_commerce/checkout/route.ts', 'typescript', ACP_ROUTE, true);
  add('llms-txt', 'Publish llms.txt', 'public/llms.txt', 'text', layer.llmsTxt, true);
  add('schema-product', 'Add Product JSON-LD to product pages', 'app/products/[slug]/page.tsx', 'html',
    `<script type="application/ld+json">\n${layer.jsonld}\n</script>`, false);
  add('ai-crawlers', 'Allow AI crawlers', 'public/robots.txt', 'text', layer.robots, false);
  return out;
}
