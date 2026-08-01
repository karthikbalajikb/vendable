import type { StoreRecord } from '../store/storeRepo.js';
import { reachable } from '../util/http.js';

export interface TrustSignal {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export interface SensoAnswer {
  key: string;
  question: string;
  grounded: boolean;
  answer: string;
}

export interface TrustReport {
  verified: boolean;
  score: number; // 0-100
  grade: string;
  mode: 'senso-live' | 'heuristic';
  signals: TrustSignal[];
  senso: SensoAnswer[];
  attestations: string[];
  verifiedAt: string;
}

/** Read config at call time — env is loaded (dotenv) after this module is imported. */
function sensoKey(): string {
  return process.env.SENSO_API_KEY ?? '';
}
function sensoBase(): string {
  return (process.env.SENSO_BASE_URL ?? 'https://apiv2.senso.ai/api/v1').replace(/\/$/, '');
}

/** True when a real Senso key is configured. */
export function sensoConfigured(): boolean {
  return !!sensoKey();
}

/** Query Senso's compiled knowledge base for a grounded, cited answer (POST /org/search). */
async function sensoSearch(query: string): Promise<{ total: number; answer: string }> {
  const res = await fetch(`${sensoBase()}/org/search`, {
    method: 'POST',
    headers: { 'X-API-Key': sensoKey(), 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Senso ${res.status}`);
  const j = (await res.json()) as { total_results?: number; answer?: string };
  return { total: j.total_results ?? 0, answer: j.answer ?? '' };
}

/**
 * Ingest a merchant's trust profile into Senso's knowledge base (POST /org/kb/raw) directly
 * from the product — no CLI. Async: Senso parses/embeds in the background, after which
 * verifyStore's /org/search returns grounded answers about the merchant.
 */
export async function ingestStore(rec: StoreRecord): Promise<{ id: string; status: string } | undefined> {
  const key = sensoKey();
  if (!key) return undefined;
  const m = rec.manifest;
  const base = m.storeUrl ?? rec.url;
  const cats = m.capabilities.catalog;
  const sample = cats.slice(0, 10).map((c) => `- ${c.title} — ${c.currency} ${c.price}`).join('\n');
  const text = [
    `# ${m.displayName} — Merchant Trust Profile`,
    ``,
    `Merchant: ${m.displayName}`,
    `Website: ${base}`,
    `Agent identity (DID): ${m.agentId}`,
    `Payment: an AI agent pays ${m.displayName} over the Prava rail (${m.payment.currency ?? 'INR'}) with a one-time, merchant-scoped card credential — no raw card data.`,
    `Catalog: ${cats.length} products, each with a title and price.`,
    ``,
    `## What ${m.displayName} sells`,
    sample || '- (catalog pending)',
    ``,
    `## Legitimacy`,
    `${m.displayName} is an onboarded merchant on Vendable with a published Agent Commerce Manifest, a machine-readable product feed, and an ACP checkout endpoint. It is discoverable and payable by AI agents via Prava.`,
  ].join('\n');
  const res = await fetch(`${sensoBase()}/org/kb/raw`, {
    method: 'POST',
    headers: { 'X-API-Key': key, 'content-type': 'application/json' },
    body: JSON.stringify({ title: `${m.displayName} — trust profile`, text }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Senso ingest ${res.status}`);
  const j = (await res.json()) as { id?: string; processing_status?: string };
  return { id: j.id ?? '', status: j.processing_status ?? 'processing' };
}

/**
 * Verify a store's trustworthiness.
 *
 * Combines REAL signals: (1) HTTP facts about the live store (HTTPS, policy pages,
 * priced catalog, resolvable agent identity/manifest) and (2) Senso grounded answers
 * from the org knowledge base (the merchant's ingested facts). Falls back to HTTP-only
 * ("heuristic") when no Senso key is configured — honestly labeled either way.
 */
export async function verifyStore(rec: StoreRecord, agentBase?: string): Promise<TrustReport> {
  const base = (rec.manifest.storeUrl ?? rec.url).replace(/\/$/, '');
  const name = rec.manifest.displayName;

  // ---- Real HTTP trust signals ----
  const signals: TrustSignal[] = [];
  signals.push({ id: 'https', label: 'Serves over HTTPS', ok: base.startsWith('https://') });

  const policyPaths = ['/privacy', '/privacy-policy', '/terms', '/terms-of-service', '/refund', '/refund-policy', '/returns', '/shipping', '/contact', '/about'];
  const found: string[] = [];
  await Promise.all(policyPaths.map(async (p) => { if (await reachable(base + p)) found.push(p); }));
  signals.push({ id: 'policies', label: 'Publishes policy pages (refund / terms / contact)', ok: found.length >= 2, detail: found.join(', ') || 'none found' });

  const catalog = rec.manifest.capabilities.catalog;
  signals.push({ id: 'catalog', label: 'Has a priced product catalog', ok: catalog.length > 0 && catalog.every((c) => c.price > 0), detail: `${catalog.length} products` });
  signals.push({ id: 'identity', label: 'Has a resolvable agent identity (DID)', ok: /^did:/.test(rec.manifest.agentId), detail: rec.manifest.agentId });

  if (agentBase) {
    signals.push({ id: 'manifest', label: 'Agent manifest resolves', ok: await reachable(`${agentBase}/.well-known/agent-commerce.json`) });
  }

  // ---- Senso grounded verification (real) ----
  const key = sensoKey();
  const senso: SensoAnswer[] = [];
  const attestations: string[] = [];
  const mode: TrustReport['mode'] = key ? 'senso-live' : 'heuristic';

  if (key) {
    const questions = [
      { key: 'legitimacy', q: `Is ${name} a legitimate, agent-ready merchant?` },
      { key: 'catalog', q: `What does ${name} sell?` },
      { key: 'payment', q: `How can an AI agent pay ${name}?` },
    ];
    for (const { key, q } of questions) {
      try {
        const r = await sensoSearch(q);
        const grounded = r.total > 0 && !/no results found/i.test(r.answer);
        senso.push({ key, question: q, grounded, answer: grounded ? r.answer : 'No verified source found in Senso.' });
        if (grounded) attestations.push(`senso:${key}`);
      } catch (e) {
        senso.push({ key, question: q, grounded: false, answer: `Senso unavailable: ${(e as Error).message}` });
      }
    }
  }

  // ---- Score: 55% real HTTP signals + 45% Senso grounding (HTTP-only when no key) ----
  const httpScore = signals.filter((s) => s.ok).length / signals.length;
  const sensoScore = senso.length ? senso.filter((s) => s.grounded).length / senso.length : 0;
  const score = Math.round((key ? httpScore * 0.55 + sensoScore * 0.45 : httpScore) * 100);
  const verified = score >= 70;
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
  for (const s of signals) if (s.ok) attestations.push(`http:${s.id}`);

  return { verified, score, grade, mode, signals, senso, attestations: [...new Set(attestations)], verifiedAt: new Date().toISOString() };
}
