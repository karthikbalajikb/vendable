import type { AgentCommerceManifest, CatalogItem, Receipt } from '../types.js';
import { MerchantAgent } from '../merchant/merchantAgent.js';
import { PravaClient } from '../prava/pravaClient.js';

/** Filler + generic-medium words that shouldn't drive product matching. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'on', 'in', 'at', 'with',
  'buy', 'get', 'me', 'my', 'i', 'want', 'need', 'a', 'some',
  'under', 'below', 'less', 'than', 'cheaper', 'max',
  'poster', 'posters', 'print', 'printed', 'framed', 'frame', 'wall', 'art',
]);

/** Naive goal parser: pull a budget number + meaningful keywords. TODO: replace with an LLM call. */
function parseGoal(goal: string): { words: Set<string>; budget: number } {
  const budgetMatch = goal.match(/(\d[\d,]*)/);
  const budget = budgetMatch ? Number(budgetMatch[1].replace(/,/g, '')) : Number.POSITIVE_INFINITY;
  const words = new Set(
    goal
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 1 && !/^\d+$/.test(w) && !STOPWORDS.has(w)),
  );
  return { words, budget };
}

export function pickItem(catalog: CatalogItem[], goal: string): CatalogItem {
  const { words, budget } = parseGoal(goal);
  const affordable = catalog.filter((i) => i.price <= budget);
  if (affordable.length === 0) throw new Error('no item within budget');

  // Score by how many meaningful goal words appear in the title; prefer the best
  // match, tie-breaking on the lower price. Fall back to cheapest if nothing matches.
  const scored = affordable
    .map((item) => {
      const titleWords = new Set(item.title.toLowerCase().split(/\W+/).filter(Boolean));
      let score = 0;
      for (const w of words) if (titleWords.has(w)) score++;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score || a.item.price - b.item.price);

  return scored[0].score > 0 ? scored[0].item : affordable.sort((a, b) => a.price - b.price)[0];
}

/** Return the top-N products matching a goal — for a "pick one of these" list. */
export function matchItems(catalog: CatalogItem[], goal: string, limit = 3): CatalogItem[] {
  const { words, budget } = parseGoal(goal);
  const affordable = catalog.filter((i) => i.price <= budget);
  const scored = affordable
    .map((item) => {
      const titleWords = new Set(item.title.toLowerCase().split(/\W+/).filter(Boolean));
      let score = 0;
      for (const w of words) if (titleWords.has(w)) score++;
      return { item, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.item.price - b.item.price);
  const matches = scored.map((s) => s.item);
  return (matches.length ? matches : affordable.sort((a, b) => a.price - b.price)).slice(0, limit);
}

/** Buyer agent: goal -> discover -> quote -> Prava scoped token -> place order. */
export async function buy(
  manifest: AgentCommerceManifest,
  goal: string,
): Promise<{ pick: CatalogItem; receipt: Receipt }> {
  const prava = new PravaClient();
  const merchant = new MerchantAgent(manifest, prava);

  const pick = pickItem(merchant.getCatalog(), goal);
  const token = await prava.requestScopedToken(manifest.payment.merchantRef!, pick.price, pick.currency);
  const receipt = await merchant.placeOrder(pick.sku, token);
  return { pick, receipt };
}

/** Direct sku checkout (ACP-style): find product -> Prava scoped token -> settle. */
export async function checkout(
  manifest: AgentCommerceManifest,
  sku: string,
): Promise<{ pick: CatalogItem; receipt: Receipt }> {
  const prava = new PravaClient();
  const merchant = new MerchantAgent(manifest, prava);
  const pick = merchant.getCatalog().find((i) => i.sku === sku);
  if (!pick) throw new Error(`unknown sku: ${sku}`);
  const token = await prava.requestScopedToken(manifest.payment.merchantRef!, pick.price, pick.currency);
  const receipt = await merchant.placeOrder(sku, token);
  return { pick, receipt };
}
