import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentCommerceManifest } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
const DATA_FILE = path.join(DATA_DIR, 'stores.json');

export interface StoreRecord {
  id: string;
  url: string;
  productCount: number;
  source?: string;
  remediated?: boolean;
  onboardedAt: string;
  manifest: AgentCommerceManifest;
}

/**
 * File-backed store of onboarded merchants. This is what makes onboarding a
 * product instead of a one-off: every store a seller submits through the
 * dashboard is persisted here and can be listed, re-onboarded, or transacted with.
 */
export class StoreRepo {
  private async load(): Promise<Record<string, StoreRecord>> {
    if (!existsSync(DATA_FILE)) return {};
    try {
      return JSON.parse(await readFile(DATA_FILE, 'utf8')) as Record<string, StoreRecord>;
    } catch {
      return {};
    }
  }

  private async persist(all: Record<string, StoreRecord>): Promise<void> {
    if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(all, null, 2));
  }

  private idFor(manifest: AgentCommerceManifest): string {
    return (manifest.displayName || 'store').toLowerCase().replace(/[^a-z0-9.-]+/g, '-');
  }

  /** Upsert a store by hostname slug (re-onboarding the same URL updates it). */
  async save(manifest: AgentCommerceManifest, url: string): Promise<StoreRecord> {
    const all = await this.load();
    const id = this.idFor(manifest);
    const record: StoreRecord = {
      id,
      url,
      productCount: manifest.capabilities.catalog.length,
      source: manifest.capabilities.source,
      onboardedAt: new Date().toISOString(),
      manifest,
    };
    all[id] = record;
    await this.persist(all);
    return record;
  }

  async list(): Promise<StoreRecord[]> {
    const all = await this.load();
    return Object.values(all).sort((a, b) => b.onboardedAt.localeCompare(a.onboardedAt));
  }

  async get(id: string): Promise<StoreRecord | undefined> {
    return (await this.load())[id];
  }

  async patch(id: string, fields: Partial<StoreRecord>): Promise<StoreRecord | undefined> {
    const all = await this.load();
    if (!all[id]) return undefined;
    all[id] = { ...all[id], ...fields };
    await this.persist(all);
    return all[id];
  }
}
