/**
 * Anthropic's published model prices, read from the pricing page's Markdown version.
 *
 * This is the only network request Session Lens makes, and only when the user asks for it
 * ("Check Anthropic's prices" on the Settings page). Nothing is sent: it is a plain GET of a public page.
 */
import type { Price } from './types.js';

export const PRICING_PAGE = 'https://platform.claude.com/docs/en/about-claude/pricing';

export interface PublishedModel {
  id: string;
  name: string;
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  /** e.g. "retired, except on Bedrock and Google Cloud" */
  note?: string;
}

/** "Claude Opus 5.5" → claude-opus-5-5; "Claude Haiku 3.5" → claude-3-5-haiku (pre-4 ids put the version first). */
export function modelIdFromName(name: string): string | undefined {
  const m = /^Claude\s+([A-Za-z]+)\s+(\d+)(?:\.(\d+))?$/.exec(name.trim());
  if (!m) return undefined;
  const family = m[1].toLowerCase();
  const version = m[3] ? `${m[2]}-${m[3]}` : m[2];
  return Number(m[2]) < 4 ? `claude-${version}-${family}` : `claude-${family}-${version}`;
}

const money = (cell: string): number | undefined => {
  const m = /\$\s*([\d,]+(?:\.\d+)?)/.exec(cell);
  return m ? Number(m[1].replace(/,/g, '')) : undefined;
};

/** Parse the "Model pricing" table out of the page's Markdown. */
export function parsePricingMarkdown(md: string): PublishedModel[] {
  const start = md.search(/^##\s+Model pricing\s*$/m);
  if (start < 0) return [];
  const lines = md.slice(start).split('\n');
  const out: PublishedModel[] = [];
  let header: string[] | undefined;
  for (const line of lines.slice(1)) {
    if (/^##\s/.test(line)) break;
    if (!line.startsWith('|')) {
      if (out.length) break; // the table has ended
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
      continue;
    }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    const col = (re: RegExp) => header!.findIndex((h) => re.test(h));
    const iName = col(/^model/);
    const vals = {
      input: money(cells[col(/base input/)] ?? ''),
      cacheWrite5m: money(cells[col(/5m cache/)] ?? ''),
      cacheWrite1h: money(cells[col(/1h cache/)] ?? ''),
      cacheRead: money(cells[col(/cache hits|cache read/)] ?? ''),
      output: money(cells[col(/^output/)] ?? ''),
    };
    const rawName = cells[iName] ?? '';
    const note = /\(([^)]*?)\]?\(/.exec(rawName)?.[1]?.replace(/^\[/, '');
    const name = rawName.replace(/\s*\(.*$/, '').trim();
    const id = modelIdFromName(name);
    const { input, cacheWrite5m, cacheWrite1h, cacheRead, output } = vals;
    if (!id || input === undefined || cacheWrite5m === undefined || cacheWrite1h === undefined || cacheRead === undefined || output === undefined) continue;
    out.push({ id, name, input, cacheWrite5m, cacheWrite1h, cacheRead, output, note });
  }
  return out;
}

export async function fetchPublishedPricing(fetchImpl: typeof fetch = fetch): Promise<{ models: PublishedModel[]; fetchedAt: string; url: string }> {
  const url = `${PRICING_PAGE}.md`;
  const res = await fetchImpl(url, { headers: { accept: 'text/markdown' } });
  if (!res.ok) throw new Error(`Anthropic's pricing page answered ${res.status}`);
  const models = parsePricingMarkdown(await res.text());
  if (!models.length) throw new Error('Could not find the model price table on the pricing page; it may have changed shape.');
  return { models, fetchedAt: new Date().toISOString(), url: PRICING_PAGE };
}

/** Compare published prices with what is in effect. */
export function comparePrices(published: PublishedModel[], effective: (id: string) => { price: Price; known: boolean }) {
  const FIELDS = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output'] as const;
  return published.map((p) => {
    const cur = effective(p.id);
    const changed = cur.known ? FIELDS.filter((f) => Math.abs(cur.price[f] - p[f]) > 1e-9) : [...FIELDS];
    return { ...p, status: !cur.known ? ('new' as const) : changed.length ? ('changed' as const) : ('same' as const), changed, current: cur.known ? cur.price : undefined };
  });
}
