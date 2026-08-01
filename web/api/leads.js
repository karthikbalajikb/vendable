// Vercel serverless function — GET /api/leads?token=...
// Token-protected view of waitlist leads from Supabase. Add &format=json for raw JSON.
import { timingSafeEqual } from 'node:crypto';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default async function handler(req, res) {
  const expected = process.env.LEADS_ADMIN_TOKEN || '';
  if (!expected) return res.status(503).json({ error: 'LEADS_ADMIN_TOKEN not configured' });

  const q = req.query || {};
  const hdr = req.headers['x-admin-token'];
  const token = q.token || (Array.isArray(hdr) ? hdr[0] : hdr) || '';
  if (!token || !safeEqual(token, expected)) return res.status(401).json({ error: 'unauthorized' });

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  let leads = [];
  if (sbUrl && sbKey) {
    try {
      const table = process.env.SUPABASE_WAITLIST_TABLE || 'waitlist';
      const r = await fetch(
        sbUrl.replace(/\/$/, '') + '/rest/v1/' + table + '?select=url,source,created_at&order=created_at.desc',
        { headers: { apikey: sbKey, authorization: 'Bearer ' + sbKey } },
      );
      if (r.ok) {
        const rows = await r.json();
        leads = rows.map((x) => ({ url: x.url, source: x.source, at: x.created_at }));
      } else {
        console.error('[leads] Supabase read failed:', r.status, await r.text());
      }
    } catch (e) {
      console.error('[leads] Supabase read error:', e);
    }
  }

  if (q.format === 'json') return res.status(200).json({ count: leads.length, leads });

  const rows = leads
    .map((l) => `<tr><td>${esc(l.at)}</td><td><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url)}</a></td><td>${esc(l.source)}</td></tr>`)
    .join('');
  const inner = leads.length
    ? `<table><thead><tr><th>When (UTC)</th><th>Store URL</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="empty">No leads yet.</div>';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vendable — Leads (${leads.length})</title><style>body{margin:0;background:#f6f4ee;color:#20242c;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}.wrap{max-width:900px;margin:0 auto;padding:28px 20px}h1{font-size:22px;margin:0 0 4px}.sub{color:#8b8a80;margin:0 0 18px}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #eae6dc;border-radius:12px;overflow:hidden}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #f1ede4;font-size:13px;word-break:break-all}th{background:#faf8f1;color:#8b8a80;text-transform:uppercase;font-size:11px;letter-spacing:.04em}tr:last-child td{border-bottom:0}a{color:#b1832f;text-decoration:none}a:hover{text-decoration:underline}.empty{padding:40px;text-align:center;color:#8b8a80;background:#fff;border:1px solid #eae6dc;border-radius:12px}</style></head><body><div class="wrap"><h1>Vendable — Leads</h1><p class="sub">${leads.length} submitted store URL(s) · newest first</p>${inner}</div></body></html>`;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}
