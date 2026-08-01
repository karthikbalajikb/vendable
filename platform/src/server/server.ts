import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onboardStore } from '../onboard/onboard.js';
import { pickItem, matchItems } from '../agent/buyerAgent.js';
import { StoreRepo } from '../store/storeRepo.js';
import { auditStore } from '../audit/audit.js';
import { generateRemediation, buildAgentLayer } from '../remediate/remediate.js';
import { PravaClient } from '../prava/pravaClient.js';
import { purchase } from '../checkout/purchase.js';
import { handleMcpRequest } from '../mcp/mcpServer.js';
import type { AgentCommerceManifest, CatalogItem } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

type Res = http.ServerResponse;

function sendJson(res: Res, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Block loopback / private / internal hosts to reduce SSRF risk from user-submitted URLs. */
function isSafeHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  return true;
}

async function serveStatic(res: Res, urlPath: string): Promise<void> {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' }); // path traversal guard
  }
  if (!existsSync(filePath)) return sendJson(res, 404, { error: 'not found' });
  const data = await readFile(filePath);
  res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
  res.end(data);
}

function buildSteps(manifest: AgentCommerceManifest, ms: number): { label: string; ok: boolean }[] {
  const n = manifest.capabilities.catalog.length;
  const src = manifest.capabilities.source ?? 'sample';
  const crawlLabel =
    src === 'shopify-api'
      ? `Crawled Shopify catalog — ${n} products`
      : src.startsWith('webcmd:')
        ? `Ran webcmd adapter "${src.slice(7)}" — ${n} products`
        : `Loaded sample catalog — ${n} products (no live adapter yet)`;
  return [
    { label: `Detected platform: ${manifest.platform}`, ok: true },
    { label: crawlLabel, ok: n > 0 },
    { label: `Minted agent identity ${manifest.agentId.slice(0, 26)}…`, ok: true },
    { label: `Provisioned Prava merchant ${manifest.payment.merchantRef ?? ''}`, ok: true },
    { label: 'Built Agent Commerce Manifest', ok: true },
    { label: `Completed in ${ms} ms`, ok: true },
  ];
}

export function startServer(port = 4000): http.Server {
  const repo = new StoreRepo();
  const agentBaseFor = (id: string) => `http://127.0.0.1:${port}/agent/${encodeURIComponent(id)}`;

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const p = url.pathname;

    try {
      // ChatGPT MCP connector (Streamable HTTP) — same origin/tunnel as the dashboard.
      if (p === '/mcp') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, mcp-session-id, mcp-protocol-version, last-event-id');
        res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
        if (method === 'OPTIONS') { res.writeHead(204); return res.end(); }
        if (method === 'POST') { await handleMcpRequest(req, res); return; }
        res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. POST to /mcp.' }, id: null }));
      }

      if (method === 'GET' && p === '/api/stores') {
        return sendJson(res, 200, { stores: await repo.list() });
      }

      const matchMatch = p.match(/^\/api\/stores\/([^/]+)\/match$/);
      if (method === 'POST' && matchMatch) {
        const rec = await repo.get(decodeURIComponent(matchMatch[1]));
        if (!rec) return sendJson(res, 404, { error: 'store not found' });
        const body = await readBody(req);
        const goal = String(body.goal ?? '').trim();
        if (!goal) return sendJson(res, 400, { error: 'goal is required' });
        return sendJson(res, 200, { items: matchItems(rec.manifest.capabilities.catalog, goal, 3) });
      }

      const buyMatch = p.match(/^\/api\/stores\/([^/]+)\/buy$/);
      if (method === 'POST' && buyMatch) {
        const rec = await repo.get(decodeURIComponent(buyMatch[1]));
        if (!rec) return sendJson(res, 404, { error: 'store not found' });
        const body = await readBody(req);
        const goal = String(body.goal ?? '').trim();
        const sku = String(body.sku ?? '').trim();
        let pick: CatalogItem | undefined;
        if (sku) pick = rec.manifest.capabilities.catalog.find((c) => c.sku === sku);
        else if (goal) {
          try { pick = pickItem(rec.manifest.capabilities.catalog, goal); }
          catch (e) { return sendJson(res, 200, { error: (e as Error).message }); }
        }
        if (!pick) return sendJson(res, 400, { error: 'provide a valid sku or goal' });

        const r = await purchase(rec, pick.sku);
        return sendJson(res, 200, {
          pick: r.pick,
          receipt: r.receipt,
          headless: r.headless,
          mandate: r.mandate,
          error: r.error,
          storeOrder: r.storeOrder,
          fulfillError: r.fulfillError,
        });
      }

      if (method === 'GET' && p.startsWith('/api/stores/')) {
        const rec = await repo.get(decodeURIComponent(p.slice('/api/stores/'.length)));
        return rec ? sendJson(res, 200, rec) : sendJson(res, 404, { error: 'store not found' });
      }

      if (method === 'POST' && p === '/api/onboard') {
        const body = await readBody(req);
        const raw = String(body.url ?? '').trim();
        let target: URL;
        try {
          target = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
        } catch {
          return sendJson(res, 400, { error: 'invalid URL' });
        }
        if (!/^https?:$/.test(target.protocol) || !isSafeHost(target.hostname)) {
          return sendJson(res, 400, { error: 'only public http(s) store URLs are allowed' });
        }
        const started = Date.now();
        const manifest = await onboardStore(target.toString());
        const record = await repo.save(manifest, target.toString());
        return sendJson(res, 200, {
          id: record.id,
          manifest,
          steps: buildSteps(manifest, Date.now() - started),
          productCount: manifest.capabilities.catalog.length,
          source: manifest.capabilities.source,
        });
      }

      if (method === 'POST' && p === '/api/audit') {
        const body = await readBody(req);
        const id = body.id ? String(body.id) : '';
        let targetUrl = String(body.url ?? '').trim();
        let manifest: AgentCommerceManifest | undefined;
        let agentBase: string | undefined;
        if (id) {
          const rec = await repo.get(id);
          if (!rec) return sendJson(res, 404, { error: 'store not found' });
          targetUrl = rec.url;
          manifest = rec.manifest;
          if (rec.remediated || body.applied) agentBase = agentBaseFor(id);
        }
        if (!targetUrl) return sendJson(res, 400, { error: 'id or url is required' });
        return sendJson(res, 200, await auditStore(targetUrl, manifest, agentBase));
      }

      if (method === 'POST' && p === '/api/prava/test') {
        const prava = new PravaClient();
        if (!prava.live) return sendJson(res, 200, { live: false, message: 'Prava MOCK mode — set PRAVA_API_KEY + PRAVA_LIVE=1 in .env, then restart.' });
        try {
          const s = await prava.createSession({ merchantName: 'Vendable Test', merchantUrl: 'https://vendable.dev', amount: 1, currency: 'USD', items: [{ description: 'Prava key test', unitPrice: 1 }] });
          return sendJson(res, 200, { live: true, ok: true, sessionId: s.sessionId, iframeUrl: s.iframeUrl, expiresAt: s.expiresAt });
        } catch (e) {
          return sendJson(res, 200, { live: true, ok: false, error: (e as Error).message });
        }
      }

      if (method === 'POST' && p === '/api/prava/mandate/setup') {
        const body = await readBody(req);
        const prava = new PravaClient();
        if (!prava.live) return sendJson(res, 200, { live: false, message: 'Set PRAVA_LIVE=1 + your secret key in .env, then restart.' });
        const rec = body.storeId ? await repo.get(String(body.storeId)) : undefined;
        const merchantName = rec?.manifest.displayName ?? 'Vendable Store';
        const merchantUrl = rec?.manifest.storeUrl ?? 'https://vendable.dev';
        const currency = rec?.manifest.payment.currency ?? 'INR';
        const cap = Number(body.cap ?? 2000);
        try {
          const s = await prava.createMandate(
            { merchantName, merchantUrl, amount: cap, currency, items: [{ description: `Agent spending mandate for ${merchantName}`, unitPrice: cap }] },
            { maxCharges: Number(body.maxCharges ?? 10) },
          );
          return sendJson(res, 200, { live: true, sessionId: s.sessionId, iframeUrl: s.iframeUrl, cap, currency });
        } catch (e) {
          return sendJson(res, 200, { live: true, error: (e as Error).message });
        }
      }

      if (method === 'GET' && p === '/api/prava/mandates') {
        const prava = new PravaClient();
        if (!prava.live) return sendJson(res, 200, { live: false, mandates: [] });
        try {
          return sendJson(res, 200, { live: true, mandates: await prava.listMandates() });
        } catch (e) {
          return sendJson(res, 200, { live: true, error: (e as Error).message, mandates: [] });
        }
      }

      if (method === 'POST' && p === '/api/prava/mandate/charge') {
        const body = await readBody(req);
        const prava = new PravaClient();
        if (!prava.live) return sendJson(res, 200, { live: false, message: 'Set PRAVA_LIVE=1 + your secret key.' });
        const mandateId = String(body.mandateId ?? '');
        const amount = Number(body.amount ?? 0);
        if (!mandateId || !amount) return sendJson(res, 400, { error: 'mandateId and amount are required' });
        try {
          const r = await prava.chargeMandate(mandateId, amount, { reference: body.reference ? String(body.reference) : undefined });
          return sendJson(res, 200, { live: true, ...r });
        } catch (e) {
          return sendJson(res, 200, { live: true, error: (e as Error).message });
        }
      }

      if (method === 'POST' && p === '/api/remediate') {
        const body = await readBody(req);
        const rec = await repo.get(String(body.id ?? ''));
        if (!rec) return sendJson(res, 404, { error: 'store not found' });
        const report = await auditStore(rec.url, rec.manifest);
        const artifacts = generateRemediation(rec, report, agentBaseFor(rec.id));
        await repo.patch(rec.id, { remediated: true });
        return sendJson(res, 200, { artifacts, agentBase: agentBaseFor(rec.id) });
      }

      if (method === 'GET' && p === '/api/search') {
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const stores = await repo.list();
        const results: unknown[] = [];
        for (const s of stores) {
          for (const it of s.manifest.capabilities.catalog) {
            if (!q || it.title.toLowerCase().includes(q)) {
              results.push({ storeId: s.id, store: s.manifest.displayName, ...it });
            }
          }
        }
        return sendJson(res, 200, { results: results.slice(0, 60), count: results.length });
      }

      // ---- hosted agent layer (zero-integration): Vendable serves the ACP/UCP artifacts ----
      const agentMatch = p.match(/^\/agent\/([^/]+)\/(.+)$/);
      if (agentMatch) {
        const rec = await repo.get(decodeURIComponent(agentMatch[1]));
        if (!rec) return sendJson(res, 404, { error: 'store not found' });
        const layer = buildAgentLayer(rec, agentBaseFor(rec.id));
        const leaf = agentMatch[2];
        if (method === 'GET' && leaf === 'llms.txt') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(layer.llmsTxt); }
        if (method === 'GET' && leaf === '.well-known/agent-commerce.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(layer.manifestJson); }
        if (method === 'GET' && leaf === '.well-known/agentic-commerce.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(layer.acpJson); }
        if (method === 'GET' && leaf === 'feed.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(layer.feedJson); }
        if (method === 'POST' && leaf === 'acp/checkout') {
          const body = await readBody(req);
          const sku = String(body.sku ?? '');
          const item = rec.manifest.capabilities.catalog.find((c) => c.sku === sku);
          if (!item) return sendJson(res, 404, { error: 'unknown sku' });
          const r = await purchase(rec, sku);
          return sendJson(res, 200, {
            order: { id: r.receipt.ref, sku: r.pick.sku, title: r.pick.title },
            receipt: r.receipt,
            protocol: 'acp',
            rail: 'prava',
            headless: r.headless,
            mandate: r.mandate,
            error: r.error,
            storeOrder: r.storeOrder,
            fulfillError: r.fulfillError,
          });
        }
        return sendJson(res, 404, { error: 'unknown agent endpoint' });
      }

      if (method === 'GET') {
        if (p === '/') return serveStatic(res, '/landing.html');
        if (p === '/app' || p.startsWith('/app/')) return serveStatic(res, '/index.html');
        return serveStatic(res, p);
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      return sendJson(res, 500, { error: (err as Error).message });
    }
  });

  server.listen(port, () => {
    console.log(`\n  Vendable → http://localhost:${port}  (landing at /, app at /app)\n`);
  });
  return server;
}
