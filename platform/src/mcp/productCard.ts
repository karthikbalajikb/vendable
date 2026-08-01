/**
 * Apps SDK / MCP Apps UI component (vanilla JS, no build step) rendered inline in
 * ChatGPT for the search_products / get_product tools. It reads the tool's
 * structuredContent ({ products: [...] }) over the MCP Apps bridge and renders a
 * grid of buyable product cards. The "Buy" button calls the `checkout` tool via
 * window.openai.callTool (with a JSON-RPC postMessage fallback) and shows the receipt.
 *
 * Product data is treated as untrusted: text goes through textContent and URLs are
 * validated to http(s) before use.
 */
export const PRODUCT_CARD_HTML = `
<div id="vd-root" class="vd-root">Loading…</div>
<style>
  .vd-root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #111; padding: 4px; }
  .vd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .vd-card { border: 1px solid #e5e7eb; border-radius: 14px; overflow: hidden; background: #fff; display: flex; flex-direction: column; }
  .vd-img { width: 100%; height: 150px; object-fit: cover; background: #f3f4f6; }
  .vd-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
  .vd-title { font-size: 14px; font-weight: 600; line-height: 1.3; }
  .vd-meta { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .vd-price { font-size: 15px; font-weight: 700; }
  .vd-store { font-size: 11px; color: #6b7280; }
  .vd-actions { display: flex; align-items: center; gap: 10px; margin-top: auto; padding-top: 6px; }
  .vd-buy { border: 0; border-radius: 9px; padding: 7px 14px; font-size: 13px; font-weight: 600; background: #111; color: #fff; cursor: pointer; }
  .vd-buy:disabled { opacity: .6; cursor: default; }
  .vd-buy.ok { background: #059669; }
  .vd-link { font-size: 12px; color: #2563eb; text-decoration: none; }
  .vd-status { font-size: 11px; min-height: 14px; color: #6b7280; }
  .vd-status.ok { color: #059669; }
  .vd-status.err { color: #dc2626; }
  .vd-empty { padding: 16px; color: #6b7280; font-size: 14px; }
  @media (prefers-color-scheme: dark) {
    .vd-root { color: #f3f4f6; }
    .vd-card { background: #1f2023; border-color: #34363b; }
    .vd-img { background: #2a2c31; }
    .vd-store, .vd-status { color: #9ca3af; }
    .vd-buy { background: #f3f4f6; color: #111; }
    .vd-buy.ok { background: #10b981; color: #04150f; }
  }
</style>
<script>
(function () {
  var openai = (typeof window !== 'undefined') ? window.openai : undefined;
  var pending = {}; var nextId = 1; var latest = null;

  function rpc(method, params) {
    var id = nextId++;
    window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params }, '*');
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window.parent) return;
    var m = ev.data; if (!m || m.jsonrpc !== '2.0') return;
    if (m.id !== undefined && pending[m.id]) {
      var pend = pending[m.id]; delete pending[m.id];
      if (m.error) pend.reject(m.error); else pend.resolve(m.result);
      return;
    }
    if (m.method === 'ui/notifications/tool-result') {
      latest = m.params && m.params.structuredContent;
      render();
    }
  }, { passive: true });

  function output() {
    if (openai && openai.toolOutput) return openai.toolOutput;
    return latest;
  }

  async function callTool(name, args) {
    if (openai && typeof openai.callTool === 'function') {
      var r = await openai.callTool(name, args);
      return (r && r.structuredContent) ? r.structuredContent : r;
    }
    var res = await rpc('tools/call', { name: name, arguments: args });
    return (res && res.structuredContent) ? res.structuredContent : res;
  }

  function money(cur, amt) {
    var sym = cur === 'INR' ? '₹' : cur === 'USD' ? '$' : cur === 'GBP' ? '£' : cur === 'EUR' ? '€' : '';
    if (sym) return sym + amt;
    return (cur ? cur + ' ' : '') + amt;
  }

  function safeUrl(u) {
    if (typeof u !== 'string') return '';
    if (u.indexOf('https://') === 0 || u.indexOf('http://') === 0) return u;
    return '';
  }

  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

  function card(p) {
    var c = el('div', 'vd-card');
    var img = safeUrl(p.image);
    if (img) {
      var im = el('img', 'vd-img'); im.src = img; im.alt = String(p.title || '');
      im.onerror = function () { im.style.display = 'none'; };
      c.appendChild(im);
    }
    var body = el('div', 'vd-body');
    var t = el('div', 'vd-title'); t.textContent = String(p.title || 'Untitled'); body.appendChild(t);

    var meta = el('div', 'vd-meta');
    var price = el('span', 'vd-price'); price.textContent = money(p.currency, p.price); meta.appendChild(price);
    if (p.store) { var st = el('span', 'vd-store'); st.textContent = String(p.store); meta.appendChild(st); }
    body.appendChild(meta);

    var status = el('div', 'vd-status');
    var actions = el('div', 'vd-actions');
    var buy = el('button', 'vd-buy'); buy.type = 'button'; buy.textContent = 'Buy';
    buy.onclick = async function () {
      buy.disabled = true; buy.textContent = 'Placing…'; status.className = 'vd-status'; status.textContent = '';
      try {
        var r = await callTool('checkout', { storeId: p.storeId, sku: p.sku });
        var rc = (r && r.receipt) ? r.receipt : {};
        if (r && r.ok) {
          buy.textContent = '✓ Purchased'; buy.classList.add('ok');
          status.className = 'vd-status ok';
          status.textContent = 'Settled' + (rc.ref ? ' · ' + String(rc.ref).slice(0, 18) : '') + (r.headless ? ' · headless mandate' : '');
        } else {
          buy.disabled = false; buy.textContent = 'Retry';
          status.className = 'vd-status err';
          status.textContent = 'Failed' + ((r && r.error) ? ' · ' + String(r.error) : '');
        }
      } catch (e) {
        buy.disabled = false; buy.textContent = 'Retry';
        status.className = 'vd-status err';
        status.textContent = 'Error placing order';
      }
    };
    actions.appendChild(buy);

    var link = safeUrl(p.url);
    if (link) { var a = el('a', 'vd-link'); a.href = link; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'View'; actions.appendChild(a); }
    body.appendChild(actions);
    body.appendChild(status);
    c.appendChild(body);
    return c;
  }

  function render() {
    var data = output() || {};
    var products = Array.isArray(data.products) ? data.products : [];
    var root = document.getElementById('vd-root');
    if (!root) return;
    root.className = 'vd-root';
    root.textContent = '';
    if (!products.length) {
      var empty = el('div', 'vd-empty'); empty.textContent = 'No products found.'; root.appendChild(empty); return;
    }
    var grid = el('div', 'vd-grid');
    for (var i = 0; i < products.length; i++) grid.appendChild(card(products[i]));
    root.appendChild(grid);
  }

  render();
})();
</script>
`.trim();
