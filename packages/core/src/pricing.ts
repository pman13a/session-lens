import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Price, Settings, Usage } from './types.js';

interface PricingFile {
  webSearchPerRequest: number;
  models: Record<string, Price>;
  fallback: Price;
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
  readonly discount: number;
  private cache = new Map<string, Price>();

  constructor(settings: Settings = {}, file: PricingFile = loadBundled()) {
    this.models = { ...file.models };
    for (const [id, p] of Object.entries(settings.prices ?? {})) {
      this.models[id] = { ...(this.models[id] ?? file.fallback), ...p };
    }
    this.fallback = file.fallback;
    this.webSearch = file.webSearchPerRequest;
    this.discount = Math.min(Math.max(settings.discount ?? 0, 0), 1);
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

  isKnown(model: string): boolean {
    const id = normalizeModel(model);
    return Object.keys(this.models).some((k) => id === k || id.startsWith(k + '-'));
  }

  /** Dollars per usage component, discount applied. Web searches ride with input. */
  costParts(model: string, u: Usage): { input: number; cacheWrite: number; cacheRead: number; output: number } {
    const p = this.price(model);
    const k = (1 - this.discount) / 1e6;
    return {
      input: (u.input * p.input + u.webSearches * this.webSearch * 1e6) * k,
      cacheWrite: (u.cacheWrite5m * p.cacheWrite5m + u.cacheWrite1h * p.cacheWrite1h) * k,
      cacheRead: u.cacheRead * p.cacheRead * k,
      output: u.output * p.output * k,
    };
  }

  cost(model: string, u: Usage): number {
    const p = this.price(model);
    const usd =
      (u.input * p.input +
        u.output * p.output +
        u.cacheWrite5m * p.cacheWrite5m +
        u.cacheWrite1h * p.cacheWrite1h +
        u.cacheRead * p.cacheRead) /
        1e6 +
      u.webSearches * this.webSearch;
    return usd * (1 - this.discount);
  }
}
