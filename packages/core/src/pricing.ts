import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Price, Settings, Usage } from './types.js';

export interface PricingFile {
  webSearchPerRequest: number;
  /** US-only inference (usage.inference_geo = us) multiplies every token price. */
  usGeoMultiplier?: number;
  models: Record<string, Price>;
  fallback: Price;
  checkedAt?: string;
  sourceUrl?: string;
}

/** Where a model's effective price came from: shipped with the build, applied from Anthropic's page, or typed in. */
export type PriceSource = 'bundled' | 'anthropic' | 'custom';

export function bundledPricing(): PricingFile {
  return loadBundled();
}

/** A new model's cache prices when only input is known: the standard multipliers (5m write 1.25×, 1h write 2×, read 0.1×). */
export function deriveCache(input: number) {
  return { cacheWrite5m: input * 1.25, cacheWrite1h: input * 2, cacheRead: input * 0.1 };
}

let bundled: PricingFile | undefined;

function loadBundled(): PricingFile {
  if (bundled) return bundled;
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/pricing.json when built; ../../../config/pricing.json when run from src (tests).
  for (const p of [join(here, 'pricing.json'), join(here, '../../../config/pricing.json')]) {
    try {
      bundled = JSON.parse(readFileSync(p, 'utf8')) as PricingFile;
      return bundled;
    } catch {
      /* try next */
    }
  }
  throw new Error('pricing.json not found');
}

/** Strip the pieces of a model id that don't change its price: `[1m]` and date suffixes. */
export function normalizeModel(model: string): string {
  return model.replace(/\[.*?\]$/, '').replace(/-\d{8}$/, '').replace(/^anthropic\./, '');
}

export class Pricer {
  private models: Record<string, Price>;
  private fallback: Price;
  readonly webSearch: number;
  readonly usGeo: number;
  readonly discount: number;
  private cache = new Map<string, Price>();

  /** Per model id: which layer its effective price came from. */
  readonly sources: Record<string, PriceSource> = {};

  constructor(settings: Settings = {}, file: PricingFile = loadBundled()) {
    // Three layers, later wins: bundled table → prices applied from Anthropic's page → the user's own edits.
    this.models = { ...file.models };
    for (const id of Object.keys(file.models)) this.sources[id] = 'bundled';
    for (const [id, p] of Object.entries(settings.published?.models ?? {})) {
      this.models[id] = { ...(this.models[id] ?? { ...file.fallback }), ...p };
      this.sources[id] = 'anthropic';
    }
    for (const [id, p] of Object.entries(settings.prices ?? {})) {
      const base = this.models[id] ?? (p.input != null ? { ...file.fallback, ...deriveCache(p.input) } : { ...file.fallback });
      this.models[id] = { ...base, ...p };
      this.sources[id] = 'custom';
    }
    this.fallback = file.fallback;
    this.webSearch = file.webSearchPerRequest;
    this.usGeo = file.usGeoMultiplier ?? 1.1;
    this.discount = clampDiscount(settings.discount) ?? 0;
    this.modelDiscounts = Object.entries(settings.modelDiscounts ?? {})
      .map(([k, v]) => [normalizeModel(k), clampDiscount(v)] as const)
      .filter((e): e is readonly [string, number] => e[1] !== undefined)
      .sort((a, b) => b[0].length - a[0].length);
  }

  private modelDiscounts: (readonly [string, number])[];

  /** 1 − the discount that applies to this model (a per-model rate beats the default). */
  discountFactor(model: string): number {
    const id = normalizeModel(model);
    const hit = this.modelDiscounts.find(([k]) => id === k || id.startsWith(k + '-'));
    return 1 - (hit ? hit[1] : this.discount);
  }

  /**
   * List-price dollars per component. Includes compaction iterations, fast-mode rates (cache prices
   * scale with input) and the US-only inference multiplier, all of which stack.
   */
  private listParts(model: string, u: Usage): { input: number; cacheWrite: number; cacheRead: number; output: number } {
    const p = this.price(model);
    const fin = u.fast && p.fast ? p.fast.input / p.input : 1;
    const fout = u.fast && p.fast ? p.fast.output / p.output : 1;
    const geo = u.usOnly ? this.usGeo : 1;
    const t = { input: u.input, cacheWrite5m: u.cacheWrite5m, cacheWrite1h: u.cacheWrite1h, cacheRead: u.cacheRead, output: u.output };
    if (u.compaction) for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += u.compaction[k];
    const inK = (fin * geo) / 1e6;
    return {
      input: t.input * p.input * inK + u.webSearches * this.webSearch,
      cacheWrite: (t.cacheWrite5m * p.cacheWrite5m + t.cacheWrite1h * p.cacheWrite1h) * inK,
      cacheRead: t.cacheRead * p.cacheRead * inK,
      output: (t.output * p.output * fout * geo) / 1e6,
    };
  }

  /** Cost at list price, before any discount: what Claude Code's own tally reports. */
  listCost(model: string, u: Usage): number {
    const x = this.listParts(model, u);
    return x.input + x.cacheWrite + x.cacheRead + x.output;
  }

  /** Longest-prefix match, so `claude-opus-4-1` falls to `claude-opus-4` and `claude-opus-5-5` beats `claude-opus-5`. */
  price(model: string): Price {
    const hit = this.cache.get(model);
    if (hit) return hit;
    const id = normalizeModel(model);
    let best: string | undefined;
    for (const key of Object.keys(this.models)) {
      if ((id === key || id.startsWith(key + '-')) && (!best || key.length > best.length)) best = key;
    }
    const p = best ? this.models[best] : this.fallback;
    this.cache.set(model, p);
    return p;
  }

  /** Every model id with a price, and where it came from. */
  table(): { id: string; price: Price; source: PriceSource }[] {
    return Object.entries(this.models)
      .map(([id, price]) => ({ id, price, source: this.sources[id] ?? 'bundled' }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The id key that prices this model (longest prefix), if any. */
  keyFor(model: string): string | undefined {
    const id = normalizeModel(model);
    let best: string | undefined;
    for (const key of Object.keys(this.models)) if ((id === key || id.startsWith(key + '-')) && (!best || key.length > best.length)) best = key;
    return best;
  }

  isKnown(model: string): boolean {
    const id = normalizeModel(model);
    return Object.keys(this.models).some((k) => id === k || id.startsWith(k + '-'));
  }

  /** Dollars per usage component, discount applied. Web searches ride with input. */
  costParts(model: string, u: Usage): { input: number; cacheWrite: number; cacheRead: number; output: number } {
    const x = this.listParts(model, u);
    const k = this.discountFactor(model);
    return { input: x.input * k, cacheWrite: x.cacheWrite * k, cacheRead: x.cacheRead * k, output: x.output * k };
  }

  cost(model: string, u: Usage): number {
    return this.listCost(model, u) * this.discountFactor(model);
  }

}

/** A discount must be a fraction below 0.95; anything else is far likelier a typo than a contract. */
function clampDiscount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 0.95 ? v : undefined;
}
