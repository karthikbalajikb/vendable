// Regenerate web/api/_stores.js (the catalog snapshot bundled into the Vercel MCP
// function) from platform/data/stores.json. Run after re-onboarding stores:
//   cd web && npm run sync:catalog   # then commit + push to redeploy
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(dir, '../../platform/data/stores.json');
const out = path.resolve(dir, '../api/_stores.js');

const s = readFileSync(src, 'utf8');
const stores = JSON.parse(s); // validate + count (throws on malformed JSON)
const ids = Object.keys(stores);
const products = ids.reduce((n, id) => n + (stores[id]?.manifest?.capabilities?.catalog?.length || 0), 0);

writeFileSync(
  out,
  '// AUTO-GENERATED snapshot of platform/data/stores.json — regenerate on catalog change.\n' +
    'export const stores = ' + s + ';\n',
);

console.log(`synced ${ids.length} store(s), ${products} products → web/api/_stores.js`);
