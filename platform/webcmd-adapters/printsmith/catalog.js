import { cli, Strategy } from '@agentrhq/webcmd/registry';
import { ArgumentError, EmptyResultError } from '@agentrhq/webcmd/errors';

// Strategy: PUBLIC / visible-ui contract. The storefront is a Next.js app with no
// public JSON product API (/products.json, /api/products -> 404) and no anti-bot.
// Products are server-rendered into the collection HTML as stable `bg-card` cards
// with an href (/products/<slug>), an <img alt> (title + image), and a ₹ price.
// So we fetch the category page server-side and parse the cards — no browser at runtime.
//
// Authored via the webcmd loop (analyze -> discover -> init -> verify) against
// https://theprintsmithstore.com. Install for local use with:
//   mkdir -p ~/.webcmd/clis/printsmith && cp catalog.js ~/.webcmd/clis/printsmith/
//   webcmd printsmith catalog --limit 5 -f json

const BASE = 'https://theprintsmithstore.com';
const PATHS = { all: '/collections/all', posters: '/posters', tshirts: '/tshirts' };

cli({
  site: 'printsmith',
  name: 'catalog',
  description: 'List PrintSmith storefront products (sku, title, price, url, image).',
  access: 'read',
  example: 'webcmd printsmith catalog --category all --limit 20 -f json',
  domain: 'printsmith',
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [
    { name: 'limit', type: 'int', default: 60, help: 'Max products to return' },
    { name: 'category', type: 'string', default: 'all', help: 'all | posters | tshirts' },
  ],
  columns: ['sku', 'title', 'price', 'currency', 'url', 'image'],
  func: async (kwargs) => {
    const category = String(kwargs.category ?? 'all').toLowerCase();
    const path = PATHS[category];
    if (!path) throw new ArgumentError(`Unknown category "${category}" (use: all | posters | tshirts)`);
    const limit = Number(kwargs.limit ?? 60);

    const res = await fetch(BASE + path, { headers: { 'user-agent': 'webcmd-printsmith/1.0' } });
    if (!res.ok) throw new EmptyResultError(`storefront returned HTTP ${res.status} for ${path}`);
    const html = await res.text();

    const rows = [];
    const seen = new Set();
    for (const card of html.split('class="group relative bg-card').slice(1)) {
      const href = card.match(/href="(\/products\/[^"]+)"/);
      if (!href) continue;
      const sku = href[1].split('/products/')[1];
      if (seen.has(sku)) continue;
      seen.add(sku);

      const alt = card.match(/<img alt="([^"]*)"/);
      const img = card.match(/src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/);
      const price = card.match(/\u20b9\s?([0-9][0-9,]*)/); // \u20b9 = ₹

      rows.push({
        sku,
        title: (alt ? alt[1] : '').trim(),
        price: price ? Number(price[1].replace(/,/g, '')) : null,
        currency: 'INR',
        url: BASE + href[1],
        image: img ? img[1] : null,
      });
      if (rows.length >= limit) break;
    }

    if (rows.length === 0) {
      throw new EmptyResultError('no products parsed from storefront HTML (page structure may have changed)');
    }
    return rows;
  },
});
