import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { StoreRepo } from '../store/storeRepo.js';
import { purchase } from '../checkout/purchase.js';
import { PRODUCT_CARD_HTML } from './productCard.js';
import type { CatalogItem } from '../types.js';

/** The product-card component is a cache key — bump the version on any HTML/JS/CSS change. */
const WIDGET_URI = 'ui://widget/product-card.html';

interface ProductCard extends CatalogItem {
  storeId: string;
  store: string;
}

/** Zod shape mirroring a ProductCard, for the tool output schemas. */
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

/** Cross-store keyword search over onboarded catalogs (word-overlap; real matches only). */
async function searchProducts(query: string, limit: number): Promise<ProductCard[]> {
  const repo = new StoreRepo();
  const stores = await repo.list();
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const hits: { score: number; p: ProductCard }[] = [];
  for (const s of stores) {
    for (const it of s.manifest.capabilities.catalog) {
      const title = it.title.toLowerCase();
      const score = words.reduce((n, w) => n + (title.includes(w) ? 1 : 0), 0);
      if (score > 0) hits.push({ score, p: { ...it, storeId: s.id, store: s.manifest.displayName } });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.p.price - b.p.price);
  return hits.slice(0, limit).map((h) => h.p);
}

/** Image CDNs used by onboarded catalogs — so the card's CSP allows product images to load. */
async function imageResourceDomains(): Promise<string[]> {
  const domains = new Set<string>(['https://theprintsmithstore.com', 'https://cdn.shopify.com']);
  try {
    const stores = await new StoreRepo().list();
    for (const s of stores) {
      for (const it of s.manifest.capabilities.catalog) {
        if (it.image && /^https:\/\//.test(it.image)) {
          try {
            domains.add('https://' + new URL(it.image).host);
          } catch {
            /* skip malformed image URL */
          }
        }
      }
    }
  } catch {
    /* repo unavailable — fall back to the static defaults */
  }
  return Array.from(domains);
}

/**
 * Build the Vendable MCP server: exposes the onboarded (webcmd-crawled) catalogs to
 * ChatGPT as `search_products` / `get_product` (rendered as buyable product cards) and
 * `checkout` (settles via Prava — headless mandate when available). Stateless: a fresh
 * server is created per request.
 */
export function createMcpServer(): McpServer {
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

  // Product-card UI resource (MCP Apps). Associated with the search/get tools below.
  server.registerResource('product-card', WIDGET_URI, {}, async () => ({
    contents: [
      {
        uri: WIDGET_URI,
        mimeType: 'text/html+skybridge',
        text: PRODUCT_CARD_HTML,
        _meta: {
          ui: {
            prefersBorder: true,
            csp: {
              connectDomains: [],
              resourceDomains: await imageResourceDomains(),
            },
          },
        },
      },
    ],
  }));

  server.registerTool(
    'search_products',
    {
      title: 'Search products',
      description:
        'Search the connected merchant catalogs (e.g. the PrintSmith store) for products matching a query, and show buyable product cards.',
      inputSchema: {
        query: z.string().describe('What to shop for, e.g. "dark knight poster" or "porsche t-shirt"'),
        limit: z.number().int().min(1).max(12).optional(),
      },
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
      const products = await searchProducts(query, limit ?? 6);
      return {
        structuredContent: { products, query },
        content: [
          {
            type: 'text',
            text: products.length
              ? 'Found ' + products.length + ' product(s) for "' + query + '".'
              : 'No products found for "' + query + '".',
          },
        ],
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
      const repo = new StoreRepo();
      const rec = await repo.get(storeId);
      const item = rec?.manifest.capabilities.catalog.find((c) => c.sku === sku);
      if (!rec || !item) {
        return {
          structuredContent: { products: [], query: sku },
          content: [{ type: 'text', text: 'Product not found for storeId "' + storeId + '" / sku "' + sku + '".' }],
          isError: true,
        };
      }
      const p: ProductCard = { ...item, storeId: rec.id, store: rec.manifest.displayName };
      return {
        structuredContent: { products: [p], query: item.title },
        content: [{ type: 'text', text: item.title + ' — ' + item.currency + ' ' + item.price }],
      };
    },
  );

  server.registerTool(
    'checkout',
    {
      title: 'Buy a product',
      description:
        'Place an order for a product (storeId + sku) and settle payment through Prava. Charges an approved ' +
        'spending mandate headlessly when available; otherwise runs the sandbox/simulated settlement.',
      inputSchema: {
        storeId: z.string(),
        sku: z.string(),
        variant: z.string().optional(),
        qty: z.number().int().min(1).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        headless: z.boolean(),
        order: z.object({ sku: z.string(), title: z.string(), store: z.string() }),
        receipt: z.object({ ref: z.string(), status: z.string(), amount: z.number(), currency: z.string() }),
        error: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
      _meta: {
        'openai/toolInvocation/invoking': 'Placing the order…',
        'openai/toolInvocation/invoked': 'Order processed.',
      },
    },
    async ({ storeId, sku }) => {
      const repo = new StoreRepo();
      const rec = await repo.get(storeId);
      if (!rec) {
        return {
          structuredContent: {
            ok: false,
            headless: false,
            order: { sku, title: '', store: '' },
            receipt: { ref: '', status: 'failed', amount: 0, currency: '' },
            error: 'store not found',
          },
          content: [{ type: 'text', text: 'Store not found: ' + storeId }],
          isError: true,
        };
      }
      try {
        const r = await purchase(rec, sku);
        const ok = r.receipt.status === 'settled';
        return {
          structuredContent: {
            ok,
            headless: r.headless,
            order: { sku: r.pick.sku, title: r.pick.title, store: rec.manifest.displayName },
            receipt: { ref: r.receipt.ref, status: r.receipt.status, amount: r.receipt.amount, currency: r.receipt.currency },
            error: r.error,
          },
          content: [
            {
              type: 'text',
              text: ok
                ? 'Order settled for ' + r.pick.title + ' (' + r.receipt.currency + ' ' + r.receipt.amount + ')' +
                  (r.headless ? ' via a headless Prava mandate.' : '.')
                : 'Checkout did not settle' + (r.error ? ': ' + r.error : '.'),
            },
          ],
        };
      } catch (e) {
        return {
          structuredContent: {
            ok: false,
            headless: false,
            order: { sku, title: '', store: rec.manifest.displayName },
            receipt: { ref: '', status: 'failed', amount: 0, currency: '' },
            error: (e as Error).message,
          },
          content: [{ type: 'text', text: 'Checkout failed: ' + (e as Error).message }],
          isError: true,
        };
      }
    },
  );

  return server;
}

/** Read + JSON-parse a request body with a hard size cap (SSRF/DoS guard). */
function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      data += c;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Handle one MCP request over a fresh stateless transport (a new server + transport per
 * POST). Shared by the standalone `startMcpServer` and the dashboard server's /mcp route.
 */
export async function handleMcpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson(req);
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/**
 * Run the ChatGPT-facing MCP connector over Streamable HTTP at /mcp (stateless: a fresh
 * server + transport per POST). Expose the port publicly (e.g. an ngrok/Cloudflare tunnel)
 * and add the https `/mcp` URL as a ChatGPT custom connector.
 */
export function startMcpServer(port = Number(process.env.MCP_PORT ?? 4001)): http.Server {
  const httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, mcp-session-id, mcp-protocol-version, last-event-id');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url ?? '/', 'http://localhost:' + port);
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found — the MCP endpoint is /mcp' }));
    }

    try {
      if (req.method === 'POST') {
        await handleMcpRequest(req, res);
        return;
      }
      // Stateless mode has no standalone SSE stream / session teardown.
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      return res.end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. POST to the stateless MCP endpoint.' }, id: null }),
      );
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: (err as Error).message }, id: null }));
      }
    }
  });

  httpServer.listen(port, () => {
    console.log(
      '\n  Vendable MCP (ChatGPT connector) → http://localhost:' + port + '/mcp' +
        '\n  Expose publicly (e.g. `ngrok http ' + port + '`) and add the https .../mcp URL as a ChatGPT custom connector.\n',
    );
  });
  return httpServer;
}
