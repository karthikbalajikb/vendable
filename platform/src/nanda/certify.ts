import { createHash } from 'node:crypto';
import type { StoreRecord } from '../store/storeRepo.js';
import type { TrustReport } from '../trust/senso.js';

/** NANDA agent-facts card — the registry artifact that lets other agents discover, trust, and transact with the store. */
export interface NandaAgentFacts {
  '@context': string;
  id: string; // did:
  type: 'MerchantAgent';
  name: string;
  description: string;
  url?: string;
  registry: string;
  self_issued: boolean;
  endpoints: Record<string, string>;
  capabilities: string[];
  payment: { rail: string; currency: string };
  catalogSize: number;
  trust: { verified: boolean; score: number; mode?: string; attestations: string[] };
  certificate?: { id: string; issuedAt: string; issuer: string; standard: string; self_issued: boolean };
  version: string;
}

export interface CertRequirements {
  payable: boolean;
  verified: boolean;
  manifestValid: boolean;
}

export interface CertResult {
  certified: boolean;
  certificateId?: string;
  issuedAt?: string;
  issuer: string;
  requirements: CertRequirements;
  reason?: string;
  agentFacts: NandaAgentFacts;
}

const ISSUER = 'vendable';

/** Build the store's NANDA agent-facts card. */
export function buildAgentFacts(rec: StoreRecord, agentBase: string, trust?: TrustReport): NandaAgentFacts {
  const m = rec.manifest;
  const t = trust ?? {
    verified: !!m.trust?.sensoVerified,
    score: Number(m.trust?.reputation ?? 0),
    attestations: m.trust?.attestations ?? [],
  };
  return {
    '@context': 'https://projectnanda.org/schema/agent-facts/v1',
    id: m.agentId,
    type: 'MerchantAgent',
    name: m.displayName,
    description: `Agent-commerce storefront for ${m.displayName} — discoverable, verified, and payable by Prava.`,
    url: m.storeUrl ?? rec.url,
    registry: 'nanda-compatible',
    self_issued: true,
    endpoints: {
      manifest: `${agentBase}/.well-known/agent-commerce.json`,
      product_feed: `${agentBase}/feed.json`,
      checkout: `${agentBase}/acp/checkout`,
      agent_facts: `${agentBase}/.well-known/agent-facts.json`,
    },
    capabilities: ['catalog', 'checkout'],
    payment: { rail: m.payment.rail, currency: m.payment.currency ?? 'INR' },
    catalogSize: m.capabilities.catalog.length,
    trust: { verified: t.verified, score: t.score, mode: (t as TrustReport).mode, attestations: t.attestations },
    version: '1.0',
  };
}

/**
 * Certify a store in Nanda Town. Certification is gated: a store must be payable (Prava),
 * Senso-verified, and have a schema-valid manifest. That gate is the trust story — only
 * verified, payable agents get a Nanda certificate other agents can rely on.
 */
export function certifyStore(
  rec: StoreRecord,
  agentBase: string,
  trust: TrustReport | undefined,
  manifestValid: boolean,
): CertResult {
  const payable = rec.manifest.payment?.rail === 'prava';
  const verified = !!trust?.verified;
  const requirements: CertRequirements = { payable, verified, manifestValid };
  const agentFacts = buildAgentFacts(rec, agentBase, trust);

  if (!payable || !verified || !manifestValid) {
    const reason = !manifestValid
      ? 'manifest failed validation'
      : !verified
      ? 'store is not Senso-verified'
      : 'store is not payable via Prava';
    return { certified: false, issuer: ISSUER, requirements, reason, agentFacts };
  }

  const issuedAt = new Date().toISOString();
  const certificateId =
    'nanda_cert_' + createHash('sha256').update(`${rec.manifest.agentId}|${issuedAt.slice(0, 10)}`).digest('hex').slice(0, 16);
  agentFacts.certificate = { id: certificateId, issuedAt, issuer: ISSUER, standard: 'nanda-agentfacts', self_issued: true };
  return { certified: true, certificateId, issuedAt, issuer: ISSUER, requirements, agentFacts };
}
