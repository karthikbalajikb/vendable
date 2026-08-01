import type { AgentCommerceManifest } from '../types.js';

export type CheckStatus = 'pass' | 'fail' | 'warn';
export interface Check { id: string; title: string; status: CheckStatus; detail: string; fix?: string; via?: 'store' | 'vendable'; }
export interface Pillar { key: string; name: string; score: number; checks: Check[]; }
export interface AuditReport {
  url: string;
  score: number;
  grade: string;
  nativeScore: number;
  nativeGrade: string;
  generatedAt: string;
  pillars: Pillar[];
  summary: { pass: number; warn: number; fail: number; total: number; hosted: number };
}

interface Fetched { ok: boolean; status: number; text: string; ct: string; }

async function get(url: string): Promise<Fetched | null> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Vendable-Audit/1.0' } });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text: text.slice(0, 800_000), ct: res.headers.get('content-type') ?? '' };
  } catch {
    return null;
  }
}

const mk = (id: string, title: string, ok: boolean, detail: string, fix: string, warnIf?: boolean): Check => ({
  id,
  title,
  status: ok ? 'pass' : warnIf ? 'warn' : 'fail',
  detail,
  fix: ok ? undefined : fix,
});

/**
 * Attributes a pass to its real source: the merchant's own site ('store') or Vendable's
 * hosted bridge / generated manifest ('vendable'). Prevents a store that implements nothing
 * from appearing natively vendable just because Vendable hosts the layer on its behalf.
 */
const mkVia = (id: string, title: string, storeOk: boolean, hostedOk: boolean, detail: string, fix: string): Check =>
  storeOk
    ? { id, title, status: 'pass', via: 'store', detail }
    : hostedOk
      ? { id, title, status: 'pass', via: 'vendable', detail }
      : { id, title, status: 'fail', detail, fix };

function grade(score: number): string {
  return score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : score >= 35 ? 'D' : 'F';
}

/** Audit a store for agent-commerce readiness across three pillars (real HTTP checks). */
export async function auditStore(url: string, manifest?: AgentCommerceManifest, agentBase?: string): Promise<AuditReport> {
  const base = url.replace(/\/$/, '');
  const productUrl = manifest?.capabilities.catalog?.find((c) => c.url)?.url;

  const [home, product, llms, robots, agentWk, feed, sitemap, aFeed, aManifest, aAcp] = await Promise.all([
    get(base),
    productUrl ? get(productUrl) : Promise.resolve(null),
    get(`${base}/llms.txt`),
    get(`${base}/robots.txt`),
    get(`${base}/.well-known/agent-commerce.json`),
    get(`${base}/products.json?limit=1`),
    get(`${base}/sitemap.xml`),
    agentBase ? get(`${agentBase}/feed.json`) : Promise.resolve(null),
    agentBase ? get(`${agentBase}/.well-known/agent-commerce.json`) : Promise.resolve(null),
    agentBase ? get(`${agentBase}/.well-known/agentic-commerce.json`) : Promise.resolve(null),
  ]);

  const homeHtml = home?.text ?? '';
  const prodHtml = product?.text ?? homeHtml;
  const hasLd = (html: string, type: RegExp) => /application\/ld\+json/i.test(html) && type.test(html);

  // ---- Pillar 1: Discoverable (AEO / answer-engine visibility) ----
  const discoverable: Check[] = [
    mk('meta-description', 'Meta description', /<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}/i.test(homeHtml),
      'Answer engines summarize the description; a strong one improves citation.',
      'Add a <meta name="description"> (120–160 chars) to the homepage and product pages.'),
    mk('canonical', 'Canonical URL', /<link[^>]+rel=["']canonical["']/i.test(homeHtml),
      'Prevents duplicate-URL dilution when agents index the store.',
      'Add <link rel="canonical"> to each page.'),
    mk('open-graph', 'Open Graph / social tags', /property=["']og:(title|image)["']/i.test(homeHtml),
      'og:title/og:image render rich cards and feed answer-engine context.',
      'Add og:title, og:description, og:image (and product:price:amount on product pages).'),
    mk('schema-product', 'Product schema.org JSON-LD', hasLd(prodHtml, /"@type"\s*:\s*"Product"/i),
      'Product JSON-LD exposes price, availability, rating in a machine-readable way — the #1 signal for AI shopping answers.',
      'Emit <script type="application/ld+json"> with schema.org Product + Offer on every product page.'),
    mk('schema-org', 'Organization / WebSite schema', hasLd(homeHtml, /"@type"\s*:\s*"(Organization|WebSite|Store)"/i),
      'Identifies the store entity to answer engines.',
      'Add Organization + WebSite JSON-LD to the homepage.'),
    mk('llms-txt', 'llms.txt', !!llms?.ok,
      'llms.txt tells AI agents what the site is and where the machine-readable feeds are.',
      'Publish /llms.txt describing the store and linking the product feed + agent manifest.'),
    mk('sitemap', 'XML sitemap', !!sitemap?.ok,
      'Lets agents enumerate every product URL.',
      'Publish /sitemap.xml listing all product URLs.'),
    mk('ai-crawlers', 'AI crawlers allowed', !robots || !/GPTBot[\s\S]*?Disallow:\s*\//i.test(robots.text),
      'Blocking GPTBot/PerplexityBot/ClaudeBot makes the store invisible to answer engines.',
      'In robots.txt, allow GPTBot, PerplexityBot, ClaudeBot, Google-Extended.', true),
  ];

  // ---- Pillar 2: Transactable (ACP + UCP) ----
  // Split what the merchant's own site serves from what Vendable hosts on its behalf.
  const storeServesManifest = !!agentWk?.ok;
  const storeServesAcp = !!agentWk?.ok && /agentic|checkout|acp/i.test(agentWk?.text ?? '');
  const storeServesFeed = !!feed?.ok;
  const transactable: Check[] = [
    mkVia('product-feed', 'Machine-readable product feed', storeServesFeed, !!aFeed?.ok,
      'ACP/UCP agents need a JSON product feed (id, title, price, availability, url, image).',
      'Publish an ACP product feed (e.g. /feed.json or products.json) — Vendable can host this for you.'),
    mkVia('acp-checkout', 'ACP agentic checkout endpoint', storeServesAcp, !!aAcp?.ok,
      'Agentic Commerce Protocol needs a delegated checkout endpoint agents can call.',
      'Expose an ACP checkout endpoint (create/confirm order) — Vendable provides a hosted ACP bridge.'),
    mkVia('ucp-manifest', 'Universal Commerce manifest', storeServesManifest, !!aManifest?.ok,
      'A commerce manifest (capabilities, catalog, payment rail, endpoint) is how agents discover how to transact.',
      'Publish /.well-known/agent-commerce.json (the Agent Commerce Manifest) — generated on onboarding.'),
    mkVia('agent-identity', 'Agent identity (DID)', false, !!manifest?.agentId?.startsWith('did:'),
      'A resolvable agent identity lets other agents trust and address the store.',
      'Mint a did:key identity for the store (done automatically at onboarding).'),
  ];

  // ---- Pillar 3: Payable (Prava) — provided by Vendable's generated manifest, not the store ----
  const payable: Check[] = [
    mkVia('prava-merchant', 'Prava merchant provisioned', false, !!manifest?.payment?.merchantRef,
      'A Prava sub-merchant lets agents pay with scoped, biometric-approved tokens.',
      'Provision a Prava merchant (done at onboarding).'),
    mkVia('payment-rail', 'Agent payment rail declared', false, manifest?.payment?.rail === 'prava',
      'The manifest must declare a rail agents can settle on.',
      'Set payment.rail = "prava" in the Agent Commerce Manifest.'),
    mkVia('checkout-token', 'Scoped-token checkout', false, !!manifest?.payment?.merchantRef,
      'Agents pay via a merchant+amount-locked Prava token instead of raw card data.',
      'Wire the checkout to request a Prava scoped token (Vendable buyer + merchant agents do this).'),
  ];

  const pillars: Pillar[] = [
    { key: 'discoverable', name: 'Discoverable (AEO)', checks: discoverable, score: 0 },
    { key: 'transactable', name: 'Transactable (ACP + UCP)', checks: transactable, score: 0 },
    { key: 'payable', name: 'Payable (Prava)', checks: payable, score: 0 },
  ];

  let pass = 0, warn = 0, fail = 0, total = 0, hosted = 0;
  const nativePillarScores: number[] = [];
  for (const p of pillars) {
    const points = p.checks.reduce((a, c) => a + (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
    p.score = Math.round((points / p.checks.length) * 100);
    // store-native: a pass only counts if the merchant's own site serves it (not Vendable's bridge)
    const nativePoints = p.checks.reduce((a, c) => a + (c.status === 'pass' && c.via !== 'vendable' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
    nativePillarScores.push((nativePoints / p.checks.length) * 100);
    for (const c of p.checks) {
      total++;
      if (c.status === 'pass') pass++;
      else if (c.status === 'warn') warn++;
      else fail++;
      if (c.status === 'pass' && c.via === 'vendable') hosted++;
    }
  }
  const score = Math.round(pillars.reduce((a, p) => a + p.score, 0) / pillars.length);
  const nativeScore = Math.round(nativePillarScores.reduce((a, s) => a + s, 0) / nativePillarScores.length);

  return { url: base, score, grade: grade(score), nativeScore, nativeGrade: grade(nativeScore), generatedAt: new Date().toISOString(), pillars, summary: { pass, warn, fail, total, hosted } };
}
