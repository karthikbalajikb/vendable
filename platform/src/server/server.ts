import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { onboardStore } from '../onboard/onboard.js';
import { pickItem, matchItems } from '../agent/buyerAgent.js';
import { StoreRepo } from '../store/storeRepo.js';
import { auditStore } from '../audit/audit.js';
import { generateRemediation, buildAgentLayer } from '../remediate/remediate.js';
import { PravaClient } from '../prava/pravaClient.js';
import { purchase } from '../checkout/purchase.js';
import { handleMcpRequest } from '../mcp/mcpServer.js';
import { verifyStore, sensoConfigured, ingestStore } from '../trust/senso.js';
import { verifyManifest } from '../manifest/verify.js';
import { certifyStore, buildAgentFacts } from '../nanda/certify.js';
import type { AgentCommerceManifest, CatalogItem } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const DATA_DIR = path.resolve(__dirname, '../../data');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
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

async function serveStatic(res: Res, urlPath: string, req?: http.IncomingMessage): Promise<void> {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' }); // path traversal guard
  }
  if (!existsSync(filePath)) return sendJson(res, 404, { error: 'not found' });
  const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const size = statSync(filePath).size;
  const range = req?.headers.range;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m) {
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'content-type': type,
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
  createReadStream(filePath).pipe(res);
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

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** Read leads from Supabase (source of truth) with a local-file fallback. */
async function loadLeads(): Promise<{ url: string; source: string; at: string }[]> {
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (sbUrl && sbKey) {
    try {
      const table = process.env.SUPABASE_WAITLIST_TABLE ?? 'waitlist';
      const r = await fetch(`${sbUrl.replace(/\/$/, '')}/rest/v1/${table}?select=url,source,created_at&order=created_at.desc`, {
        headers: { apikey: sbKey, authorization: `Bearer ${sbKey}` },
      });
      if (r.ok) {
        const rows = (await r.json()) as { url: string; source: string; created_at: string }[];
        return rows.map((x) => ({ url: x.url, source: x.source, at: x.created_at }));
      }
    } catch { /* fall back to local file */ }
  }
  const file = path.join(DATA_DIR, 'waitlist.json');
  if (existsSync(file)) {
    try {
      const list = JSON.parse(await readFile(file, 'utf8')) as { url: string; source: string; at: string }[];
      return list.slice().reverse();
    } catch { /* ignore */ }
  }
  return [];
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

        // Trust gate (the required failure case): refuse the Prava token for merchants that
        // aren't Senso-verified / Nanda-certified. `simulateUntrusted` forces it for demos.
        const enforceTrust = body.enforceTrust !== false;
        const simulateUntrusted = body.simulateUntrusted === true;
        const trusted = !simulateUntrusted && (rec.certification?.certified === true || rec.trustReport?.verified === true);
        if (enforceTrust && !trusted) {
          console.warn(`[trust-gate] BLOCKED purchase at ${rec.id} (${pick.sku})${simulateUntrusted ? ' — simulated untrusted' : ' — merchant not verified'}`);
          return sendJson(res, 200, {
            pick,
            refused: true,
            stage: 'trust-gate',
            reason: simulateUntrusted
              ? 'Simulated untrusted merchant — the Senso trust gate refused the Prava token. No charge was made.'
              : 'Merchant is not Senso-verified / Nanda-certified — the Senso trust gate refused the Prava token. No charge was made.',
            trust: simulateUntrusted ? { verified: false, certified: false } : { verified: rec.trustReport?.verified ?? false, certified: rec.certification?.certified ?? false },
          });
        }

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
        void ingestStore(record).catch(() => {}); // best-effort Senso ingest (async, from the product)
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

      if (method === 'POST' && p === '/api/manifest/verify') {
        const body = await readBody(req);
        const rec = await repo.get(String(body.id ?? ''));
        if (!rec) return sendJson(res, 404, { error: 'store not found' });
        return sendJson(res, 200, await verifyManifest(rec, agentBaseFor(rec.id)));
      }

      if (method === 'POST' && p === '/api/trust/ingest') {
        const body = await readBody(req);
        const rec = await repo.get(String(body.id ?? ''));
        if (!rec) return sendJson(res, 404, { error: 'store not found' });
        if (!sensoConfigured()) return sendJson(res, 200, { ingested: false, message: 'No Senso key set (SENSO_API_KEY).' });
        try {
          const out = await ingestStore(rec);
          await repo.patch(rec.id, { sensoIngestedAt: new Date().toISOString() });
          return sendJson(res, 200, { ingested: true, ...out });
        } catch (e) {
          return sendJson(res, 200, { ingested: false, error: (e as Error).message });
        }
      }

      if (method === 'POST' && p === '/api/trust/verify') {
        const body = await readBody(req);
        const rec = await repo.get(String(body.id ?? ''));
        if (!rec) return sendJson(res, 404, { error: 'store not found' });
        const report = await verifyStore(rec, agentBaseFor(rec.id));
        await repo.patch(rec.id, {
          trustReport: report,
          manifest: { ...rec.manifest, trust: { sensoVerified: report.verified, reputation: report.score, attestations: report.attestations } },
        });
        return sendJson(res, 200, { report, sensoConfigured: sensoConfigured() });
      }

      if (method === 'POST' && p === '/api/nanda/certify') {
        const body = await readBody(req);
        const rec = await repo.get(String(body.id ?? ''));
        if (!rec) return sendJson(res, 404, { error: 'store not found' });
        const agentBase = agentBaseFor(rec.id);
        const manifestReport = await verifyManifest(rec, agentBase);
        const trust = rec.trustReport ?? (await verifyStore(rec, agentBase));
        const cert = certifyStore(rec, agentBase, trust, manifestReport.valid);
        if (cert.certified) await repo.patch(rec.id, { certification: cert, trustReport: trust });
        return sendJson(res, 200, { cert, manifestValid: manifestReport.valid, trust });
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

      if (method === 'POST' && p === '/api/waitlist') {
        const body = await readBody(req);
        const raw = String(body.url ?? '').trim();
        if (!raw) return sendJson(res, 400, { error: 'Please enter your store URL.' });
        let normalized: string;
        try {
          const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
          if (!/^https?:$/.test(u.protocol)) throw new Error('bad');
          normalized = u.toString();
        } catch {
          return sendJson(res, 400, { error: 'Please enter a valid store URL.' });
        }
        const file = path.join(DATA_DIR, 'waitlist.json');
        await mkdir(DATA_DIR, { recursive: true });
        let list: unknown[] = [];
        if (existsSync(file)) { try { list = JSON.parse(await readFile(file, 'utf8')) as unknown[]; } catch { list = []; } }
        const record = { url: normalized, source: String(body.source ?? 'landing'), at: new Date().toISOString() };
        list.push(record);
        await writeFile(file, JSON.stringify(list, null, 2));
        // Durable backup: mirror each lead to a Google Sheet / Zapier / Airtable webhook if configured.
        const hook = process.env.WAITLIST_WEBHOOK_URL;
        if (hook) void fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record) }).catch(() => {});
        // Persist to Supabase (durable store) if configured.
        const sbUrl = process.env.SUPABASE_URL;
        const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;
        if (sbUrl && sbKey) {
          try {
            const table = process.env.SUPABASE_WAITLIST_TABLE ?? 'waitlist';
            const r = await fetch(`${sbUrl.replace(/\/$/, '')}/rest/v1/${table}`, {
              method: 'POST',
              headers: { apikey: sbKey, authorization: `Bearer ${sbKey}`, 'content-type': 'application/json', prefer: 'return=minimal' },
              body: JSON.stringify({ url: normalized, source: record.source }),
            });
            if (!r.ok) console.error(`[waitlist] Supabase insert failed: ${r.status} ${await r.text()}`);
          } catch (e) {
            console.error('[waitlist] Supabase error:', (e as Error).message);
          }
        }
        return sendJson(res, 200, { ok: true });
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
        if (method === 'GET' && leaf === '.well-known/agent-facts.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(rec.certification?.agentFacts ?? buildAgentFacts(rec, agentBaseFor(rec.id), rec.trustReport), null, 2)); }
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

      if (method === 'GET' && p === '/api/leads') {
        const expected = process.env.LEADS_ADMIN_TOKEN ?? '';
        if (!expected) return sendJson(res, 503, { error: 'LEADS_ADMIN_TOKEN not configured' });
        const hdr = req.headers['x-admin-token'];
        const token = url.searchParams.get('token') ?? (Array.isArray(hdr) ? hdr[0] : hdr) ?? '';
        if (!token || !safeEqual(token, expected)) return sendJson(res, 401, { error: 'unauthorized' });
        const leads = await loadLeads();
        if (url.searchParams.get('format') === 'json') return sendJson(res, 200, { count: leads.length, leads });
        const rows = leads
          .map((l) => `<tr><td>${escapeHtml(l.at)}</td><td><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.url)}</a></td><td>${escapeHtml(l.source)}</td></tr>`)
          .join('');
        const inner = leads.length
          ? `<table><thead><tr><th>When (UTC)</th><th>Store URL</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>`
          : '<div class="empty">No leads yet.</div>';
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vendable — Leads (${leads.length})</title><style>body{margin:0;background:#f6f4ee;color:#20242c;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}.wrap{max-width:900px;margin:0 auto;padding:28px 20px}h1{font-size:22px;margin:0 0 4px}.sub{color:#8b8a80;margin:0 0 18px}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #eae6dc;border-radius:12px;overflow:hidden}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #f1ede4;font-size:13px;word-break:break-all}th{background:#faf8f1;color:#8b8a80;text-transform:uppercase;font-size:11px;letter-spacing:.04em}tr:last-child td{border-bottom:0}a{color:#b1832f;text-decoration:none}a:hover{text-decoration:underline}.empty{padding:40px;text-align:center;color:#8b8a80;background:#fff;border:1px solid #eae6dc;border-radius:12px}</style></head><body><div class="wrap"><h1>Vendable — Leads</h1><p class="sub">${leads.length} submitted store URL(s) · newest first</p>${inner}</div></body></html>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (method === 'GET') {
        if (p === '/') return serveStatic(res, '/landing.html', req);
        if (p === '/app' || p.startsWith('/app/')) return serveStatic(res, '/index.html', req);
        return serveStatic(res, p, req);
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
