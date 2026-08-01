// Shared TypeScript types — mirror of shared/manifest.schema.json

export interface CatalogItem {
  sku: string;
  title: string;
  price: number;
  currency: string;
  variants?: string[];
  url?: string;
  image?: string;
}

export interface AgentCommerceManifest {
  agentId: string;
  displayName: string;
  storeUrl?: string;
  fulfillmentUrl?: string;
  platform?: 'shopify' | 'woocommerce' | 'custom' | 'unknown';
  capabilities: { catalog: CatalogItem[]; adapter?: string; source?: string };
  payment: { rail: 'prava'; merchantRef?: string; currency?: string; tokenEndpoint?: string };
  endpoint: string;
  trust?: { attestations?: string[]; sensoVerified?: boolean; reputation?: number };
}

export interface ScopedToken {
  token: string;
  merchantRef: string;
  amount: number;
  currency: string;
  expiresAt: string;
}

export interface Receipt {
  ref: string;
  status: 'settled' | 'pending' | 'failed';
  amount: number;
  currency: string;
  sessionId?: string;
  iframeUrl?: string;
}
