// Vercel serverless function — POST /api/waitlist
// Stores a submitted store URL in Supabase (service-role key, server-side only).
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const raw = String(body.url || '').trim();
  if (!raw) return res.status(400).json({ error: 'Please enter your store URL.' });

  let normalized;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
    normalized = u.toString();
  } catch {
    return res.status(400).json({ error: 'Please enter a valid store URL.' });
  }

  const source = String(body.source || 'landing').slice(0, 64);
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    const table = process.env.SUPABASE_WAITLIST_TABLE || 'waitlist';
    const r = await fetch(sbUrl.replace(/\/$/, '') + '/rest/v1/' + table, {
      method: 'POST',
      headers: {
        apikey: sbKey,
        authorization: 'Bearer ' + sbKey,
        'content-type': 'application/json',
        prefer: 'return=minimal',
      },
      body: JSON.stringify({ url: normalized, source }),
    });
    if (!r.ok) {
      console.error('[waitlist] Supabase insert failed:', r.status, await r.text());
      return res.status(502).json({ error: 'Could not save right now. Please try again.' });
    }
  } catch (e) {
    console.error('[waitlist] Supabase error:', e);
    return res.status(502).json({ error: 'Could not save right now. Please try again.' });
  }

  return res.status(200).json({ ok: true });
}
