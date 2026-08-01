import { z } from 'zod';
import type { StoreRecord } from '../store/storeRepo.js';
import { probe } from '../util/http.js';

export interface ManifestCheck {
  id: string;
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ManifestVerifyReport {
  valid: boolean;
  checks: ManifestCheck[];
}

/** zod mirror of shared/manifest.schema.json (the fields agents rely on). */
const catalogItemSchema = z.object({
  sku: z.string().min(1),
  title: z.string().min(1),
  price: z.number(),
  currency: z.string().min(1),
});

const manifestSchema = z.object({
  agentId: z.string().regex(/^did:/, 'must be a DID (did:…)'),
  displayName: z.string().min(1),
  capabilities: z.object({ catalog: z.array(catalogItemSchema) }),
  payment: z.object({ rail: z.literal('prava') }),
  endpoint: z.string().min(1),
});

/** Validate the manifest against the schema and confirm the hosted agent endpoints resolve. */
export async function verifyManifest(rec: StoreRecord, agentBase?: string): Promise<ManifestVerifyReport> {
  const checks: ManifestCheck[] = [];
  const m = rec.manifest;

  const parsed = manifestSchema.safeParse(m);
  checks.push({
    id: 'schema',
    label: 'Matches Agent Commerce Manifest schema',
    ok: parsed.success,
    detail: parsed.success ? 'all required fields present' : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  });
  checks.push({ id: 'did', label: 'agentId is a decentralized identity (DID)', ok: /^did:/.test(m.agentId), detail: m.agentId });
  checks.push({
    id: 'catalog',
    label: 'Catalog is non-empty and fully priced',
    ok: m.capabilities.catalog.length > 0 && m.capabilities.catalog.every((c) => c.price > 0),
    detail: `${m.capabilities.catalog.length} products`,
  });
  checks.push({ id: 'payment', label: 'Payment rail is Prava', ok: m.payment?.rail === 'prava' });

  if (agentBase) {
    const endpoints: [string, string][] = [
      ['feed', 'feed.json'],
      ['manifest', '.well-known/agent-commerce.json'],
      ['acp', '.well-known/agentic-commerce.json'],
    ];
    for (const [id, leaf] of endpoints) {
      const code = await probe(`${agentBase}/${leaf}`);
      checks.push({ id: `ep_${id}`, label: `Hosted ${leaf} resolves`, ok: code >= 200 && code < 400, detail: `HTTP ${code}` });
    }
  }

  return { valid: checks.every((c) => c.ok), checks };
}
