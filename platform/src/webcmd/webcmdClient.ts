import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { CatalogItem } from '../types.js';

const execFileAsync = promisify(execFile);

export interface WebcmdCommand {
  site: string;
  command: string;
  strategy: 'PUBLIC' | 'COOKIE' | 'INTERCEPT' | 'UI' | 'LOCAL' | string;
  browser: boolean;
}

export interface CheckoutResult {
  orderRef: string;
  status: string;
  total?: number;
  currency?: string;
  simulated?: boolean;
  raw?: unknown;
}

type Flag = string | number | boolean | undefined;

/** Sample PrintSmith catalog returned in MOCK mode (single source of truth). */
const PRINTSMITH_SAMPLE: CatalogItem[] = [
  {
    sku: 'dark-knight-a3',
    title: 'The Dark Knight Rises — Framed Print (A3)',
    price: 399,
    currency: 'INR',
    variants: ['A3', 'A4', '13x19'],
    url: 'https://theprintsmithstore.com/products/the-dark-knight-rises-mpdws4wr',
  },
  { sku: 'prime-transformer-a3', title: 'Prime Transformer — Framed Print (A3)', price: 199, currency: 'INR', variants: ['A3', 'A4', '13x19'] },
  { sku: 'porsche-911-tshirt', title: 'Porsche 911 T-Shirt', price: 699, currency: 'INR', variants: ['S', 'M', 'L', 'XL', 'XXL'] },
];

/**
 * Client for the webcmd CLI — the self-learning browser that compiles repeated
 * browser work into deterministic commands (`webcmd <site> <command> -f json`).
 *
 * During onboarding an agent runs webcmd's Control -> Remember -> Author -> Execute
 * loop (INTERCEPT strategy) against a no-API store to author a reusable `<adapter>`
 * with `catalog` and `checkout` commands. This client then invokes those compiled
 * commands.
 *
 * Runs in MOCK mode when webcmd is unavailable or `WEBCMD_LIVE` != 1, so the
 * platform runs offline. webcmd is only for no-API stores (e.g. PrintSmith) — never
 * for services that already expose an API (Prava, GitHub).
 */
export class WebcmdClient {
  private bin = process.env.WEBCMD_BIN ?? 'webcmd';
  private forceLive = process.env.WEBCMD_LIVE === '1';
  private cachedAvailable: boolean | null = null;

  constructor(private opts: { mock?: boolean } = {}) {}

  /** True when we should simulate instead of shelling out to webcmd. */
  async isMock(): Promise<boolean> {
    if (this.opts.mock) return true;
    if (!this.forceLive) return true; // opt in to live with WEBCMD_LIVE=1
    return !(await this.hasBinary());
  }

  /** Whether the `webcmd` binary is on PATH. */
  async hasBinary(): Promise<boolean> {
    if (this.cachedAvailable !== null) return this.cachedAvailable;
    try {
      await execFileAsync(this.bin, ['--version'], { timeout: 5_000 });
      this.cachedAvailable = true;
    } catch {
      this.cachedAvailable = false;
    }
    return this.cachedAvailable;
  }

  private flagArgs(flags: Record<string, Flag>): string[] {
    const out: string[] = [];
    for (const [k, v] of Object.entries(flags)) {
      if (v === false || v === undefined || v === null) continue;
      out.push(`--${k}`);
      if (v !== true) out.push(String(v));
    }
    return out;
  }

  private async exec(args: string[]): Promise<unknown> {
    const { stdout } = await execFileAsync(this.bin, args, {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  }

  /** Run a compiled adapter command: `webcmd <site> <command> [--flags] -f json`. */
  async run(site: string, command: string, flags: Record<string, Flag> = {}): Promise<unknown> {
    return this.exec([site, command, ...this.flagArgs(flags), '-f', 'json']);
  }

  /** `webcmd list -f json` — authored commands across sites. */
  async list(): Promise<WebcmdCommand[]> {
    if (await this.isMock()) {
      return [
        { site: 'printsmith', command: 'catalog', strategy: 'INTERCEPT', browser: true },
        { site: 'printsmith', command: 'checkout', strategy: 'UI', browser: true },
      ];
    }
    return extractArray(await this.exec(['list', '-f', 'json'])).map((c) => {
      const r = (c ?? {}) as Record<string, unknown>;
      return {
        site: String(r.site ?? ''),
        command: String(r.command ?? ''),
        strategy: String(r.strategy ?? 'UI'),
        browser: Boolean(r.browser),
      };
    });
  }

  /** Discover the store catalog via the compiled `<adapter> catalog` command. */
  async crawlCatalog(adapter: string): Promise<CatalogItem[]> {
    if (await this.isMock()) return PRINTSMITH_SAMPLE;
    return extractArray(await this.run(adapter, 'catalog')).map(toCatalogItem);
  }

  /**
   * Drive the store checkout for a sku via the compiled `<adapter> checkout` command.
   *
   * SAFETY: checkout places a real order, so it stays SIMULATED unless BOTH
   * `WEBCMD_LIVE=1` and `WEBCMD_CHECKOUT_LIVE=1` are set. This lets the catalog crawl
   * run live while the buyer flow never places real paid orders by default.
   */
  async checkout(adapter: string, args: { sku: string; variant?: string; qty?: number }): Promise<CheckoutResult> {
    const live = !(await this.isMock()) && process.env.WEBCMD_CHECKOUT_LIVE === '1';
    if (!live) {
      return { orderRef: `wc_${adapter}_${randomUUID().slice(0, 8)}`, status: 'ready_for_payment', simulated: true };
    }
    const json = (await this.run(adapter, 'checkout', { ...args })) as Record<string, unknown>;
    const o = (json?.output ?? json) as Record<string, unknown>;
    return {
      orderRef: String(o.orderRef ?? o.order_id ?? o.ref ?? `wc_${randomUUID().slice(0, 8)}`),
      status: String(o.status ?? 'ready_for_payment'),
      total: o.total != null ? Number(o.total) : undefined,
      currency: o.currency != null ? String(o.currency) : undefined,
      raw: json,
    };
  }
}

/** Defensively pull an array payload out of a webcmd JSON envelope. */
export function extractArray(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    for (const key of ['output', 'results', 'items', 'catalog', 'products', 'matches', 'commands', 'data']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
    for (const v of Object.values(obj)) if (Array.isArray(v)) return v as unknown[];
  }
  return [];
}

function toCatalogItem(row: unknown): CatalogItem {
  const r = (row ?? {}) as Record<string, unknown>;
  return {
    sku: String(r.sku ?? r.id ?? r.handle ?? ''),
    title: String(r.title ?? r.name ?? ''),
    price: Number(r.price ?? r.amount ?? 0),
    currency: String(r.currency ?? 'INR'),
    variants: Array.isArray(r.variants) ? r.variants.map(String) : undefined,
    url: r.url != null ? String(r.url) : undefined,
    image: r.image != null ? String(r.image) : undefined,
  };
}
