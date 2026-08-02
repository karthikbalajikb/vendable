// Vendable MCP connector as a Vercel serverless function (Streamable HTTP, stateless).
// Exposes the bundled catalog to ChatGPT as search_products / get_product (buyable product
// cards) + checkout (settles via Prava). Self-contained: the source of truth lives in
// platform/src/mcp/*; this is the deployable Vercel mirror. Reached at /mcp via the rewrite
// in vercel.json. Env (Vercel → Settings → Environment Variables): PRAVA_SECRET_KEY,
// PRAVA_API_KEY, PRAVA_BASE_URL, PRAVA_LIVE=1, PRAVA_USER_ID, PRAVA_USER_EMAIL.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { stores as STORES } from './_stores.js';
import { PRODUCT_CARD_HTML } from './_widget.js';
import { settle } from './_prava.js';

const WIDGET_URI = 'ui://widget/product-card-v2.html';
const STORE_LIST = Object.values(STORES);

const productShape = {
  sku: z.string(),
  title: z.string(),
  price: z.number(),
  currency: z.string(),
  storeId: z.string(),
  store: z.string(),
  url: z.string().optional(),
  image: z.string().optional(),
  variants: z.array(z.string()).optional(),
};

/** Cross-store keyword search over the bundled catalogs (word-overlap; real matches only). */
function searchProducts(query, limit) {
  const words = String(query).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const hits = [];
  for (const rec of STORE_LIST) {
    for (const it of rec.manifest.capabilities.catalog) {
      const title = String(it.title).toLowerCase();
      const score = words.reduce((n, w) => n + (title.includes(w) ? 1 : 0), 0);
      if (score > 0) hits.push({ score, p: { ...it, storeId: rec.id, store: rec.manifest.displayName } });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.p.price - b.p.price);
  return hits.slice(0, limit).map((h) => h.p);
}

function imageResourceDomains() {
  const domains = new Set(['https://theprintsmithstore.com', 'https://cdn.shopify.com']);
  for (const rec of STORE_LIST) {
    for (const it of rec.manifest.capabilities.catalog) {
      if (it.image && /^https:\/\//.test(it.image)) {
        try { domains.add('https://' + new URL(it.image).host); } catch { /* skip */ }
      }
    }
  }
  return Array.from(domains);
}

const findStore = (storeId) => STORES[storeId] || STORE_LIST.find((r) => r.id === storeId);
const findItem = (rec, sku) => rec?.manifest?.capabilities?.catalog?.find((c) => c.sku === sku);

function createServer() {
  const server = new McpServer(
    { name: 'vendable-commerce', version: '0.1.0' },
    {
      instructions:
        'Vendable makes no-API merchant stores (e.g. the PrintSmith store) shoppable by agents. ' +
        'Use search_products to find items and show buyable product cards; use get_product for one item; ' +
        'call checkout with a product storeId + sku to place the order — it settles through Prava and ' +
        'charges an approved spending mandate headlessly when available.',
    },
  );

  server.registerResource('product-card', WIDGET_URI, {}, async () => ({
    contents: [
      {
        uri: WIDGET_URI,
        mimeType: 'text/html+skybridge',
        text: PRODUCT_CARD_HTML,
        _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: imageResourceDomains() } } },
      },
    ],
  }));

  server.registerTool(
    'search_products',
    {
      title: 'Search products',
      description: 'Search the connected merchant catalogs (e.g. the PrintSmith store) for products matching a query, and show buyable product cards.',
      inputSchema: { query: z.string().describe('What to shop for, e.g. "dark knight poster"'), limit: z.number().int().min(1).max(12).optional() },
      outputSchema: { products: z.array(z.object(productShape)), query: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
      _meta: {
        'openai/outputTemplate': WIDGET_URI,
        ui: { resourceUri: WIDGET_URI },
        'openai/toolInvocation/invoking': 'Searching the store…',
        'openai/toolInvocation/invoked': 'Here are some matches.',
      },
    },
    async ({ query, limit }) => {
      const products = searchProducts(query, limit ?? 6);
      return {
        structuredContent: { products, query },
        content: [{ type: 'text', text: products.length ? `Found ${products.length} product(s) for "${query}".` : `No products found for "${query}".` }],
      };
    },
  );

  server.registerTool(
    'get_product',
    {
      title: 'Get product',
      description: 'Show a single product card by storeId + sku.',
      inputSchema: { storeId: z.string(), sku: z.string() },
      outputSchema: { products: z.array(z.object(productShape)), query: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
      _meta: { 'openai/outputTemplate': WIDGET_URI, ui: { resourceUri: WIDGET_URI } },
    },
    async ({ storeId, sku }) => {
      const rec = findStore(storeId);
      const item = findItem(rec, sku);
      if (!rec || !item) {
        return { structuredContent: { products: [], query: sku }, content: [{ type: 'text', text: `Product not found for storeId "${storeId}" / sku "${sku}".` }], isError: true };
      }
      return {
        structuredContent: { products: [{ ...item, storeId: rec.id, store: rec.manifest.displayName }], query: item.title },
        content: [{ type: 'text', text: `${item.title} — ${item.currency} ${item.price}` }],
      };
    },
  );

  server.registerTool(
    'checkout',
    {
      title: 'Buy a product',
      description: 'Place an order for a product (storeId + sku) and settle payment through Prava. Charges an approved spending mandate headlessly when available.',
      inputSchema: { storeId: z.string(), sku: z.string(), variant: z.string().optional(), qty: z.number().int().min(1).optional() },
      outputSchema: {
        ok: z.boolean(),
        headless: z.boolean(),
        order: z.object({ sku: z.string(), title: z.string(), store: z.string() }),
        receipt: z.object({ ref: z.string(), status: z.string(), amount: z.number(), currency: z.string() }),
        error: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
      _meta: { 'openai/toolInvocation/invoking': 'Placing the order…', 'openai/toolInvocation/invoked': 'Order processed.' },
    },
    async ({ storeId, sku }) => {
      const rec = findStore(storeId);
      const item = findItem(rec, sku);
      if (!rec || !item) {
        return {
          structuredContent: { ok: false, headless: false, order: { sku, title: '', store: '' }, receipt: { ref: '', status: 'failed', amount: 0, currency: '' }, error: 'unknown store/sku' },
          content: [{ type: 'text', text: `Unknown store/sku: ${storeId} / ${sku}` }],
          isError: true,
        };
      }
      try {
        const r = await settle(rec, item);
        return {
          structuredContent: {
            ok: r.ok,
            headless: r.headless,
            order: { sku: item.sku, title: item.title, store: rec.manifest.displayName },
            receipt: r.receipt,
            error: r.error,
          },
          content: [
            {
              type: 'text',
              text: r.ok
                ? `Order settled for ${item.title} (${item.currency} ${item.price})${r.headless ? ' via a headless Prava mandate.' : '.'}`
                : `Checkout did not settle${r.error ? ': ' + r.error : '.'}`,
            },
          ],
        };
      } catch (e) {
        return {
          structuredContent: { ok: false, headless: false, order: { sku: item.sku, title: item.title, store: rec.manifest.displayName }, receipt: { ref: '', status: 'failed', amount: item.price, currency: item.currency }, error: String(e?.message || e) },
          content: [{ type: 'text', text: 'Checkout failed: ' + String(e?.message || e) }],
          isError: true,
        };
      }
    },
  );

  return server;
}

/** Read + parse the JSON body whether Vercel pre-parsed it (req.body) or not (raw stream). */
async function readBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, mcp-session-id, mcp-protocol-version, last-event-id');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. POST to /mcp.' }, id: null }));
  }
  try {
    const body = await readBody(req);
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err?.message || 'internal error' }, id: null }));
    }
  }
}
