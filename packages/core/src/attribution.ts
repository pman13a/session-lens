import type { Store } from './store.js';
import type { ContentPiece, ItemKind, Rec, Request } from './types.js';

export interface ContextItem {
  /** `<record uuid>:<block>` — stable across requests, used for diffs and raw lookups. */
  id: string;
  uuid: string;
  block: number;
  kind: ItemKind;
  label: string;
  detail?: string;
  chars: number;
  /** Estimated tokens. Items of one request always sum to its measured input total. */
  tokens: number;
  /** Not present in the previous request's context on the same thread: this turn added it. */
  added: boolean;
  ts: number;
  toolName?: string;
}

export interface OutputItem {
  id: string;
  uuid: string;
  block: number;
  kind: ItemKind;
  label: string;
  detail?: string;
  chars: number;
  tokens: number;
}

export interface Attribution {
  requestId: string;
  measuredInput: number;
  baselineTokens: number;
  /** Measured tokens the transcript content can't account for. */
  unattributedTokens: number;
  items: ContextItem[];
  output: OutputItem[];
  previousRequestId?: string;
  addedTokens: number;
  /** Characters per token calibrated for this thread. */
  charsPerToken: number;
}

/** Used until a thread has enough request-to-request growth to calibrate on. */
export const DEFAULT_CHARS_PER_TOKEN = 3;

function piecesOf(recs: Rec[]): { rec: Rec; piece: ContentPiece }[] {
  const out: { rec: Rec; piece: ContentPiece }[] = [];
  for (const rec of recs) for (const piece of rec.pieces) out.push({ rec, piece });
  return out;
}

/** Spread `total` over `weights` proportionally, as integers that sum to exactly `total`. */
export function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (w / sum) * total);
  const out = raw.map(Math.floor);
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) out[order[k][1]]++;
  return out;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Requests on the same thread (main or one subagent), in order. */
export function threadRequests(store: Store, req: Request): Request[] {
  const s = store.sessions.get(req.sessionId);
  if (!s) return [req];
  const ids = req.agentId ? s.subagents.find((a) => a.agentId === req.agentId)?.requestIds ?? [] : s.requestIds;
  return ids.map((id) => store.requests.get(id)!).filter(Boolean).sort((a, b) => a.ts - b.ts);
}

interface Step {
  id: string;
  ts: number;
  measured: number;
  chars: number;
  /** Tools called by the previous request: whatever they loaded shows up in this one. */
  after: string[];
}

export interface ThreadProfile {
  charsPerToken: number;
  /** System prompt + tool definitions, measured once on the thread's first request. */
  baseline: number;
  steps: Step[];
  index: Map<string, number>;
}

const profiles = new Map<string, ThreadProfile>();

/**
 * Per-thread calibration.
 *
 * - Chars per token: the median of (Δ visible chars / Δ measured tokens) between consecutive requests.
 *   chars/4 under-counts badly on current tokenizers (~2.3 measured), and a single global
 *   scale-to-fit would smear tokens that never appear in the transcript over every item.
 * - Baseline: measured ONCE on the first request. Refreshing it later banks the accumulated
 *   estimation error as fake "system prompt".
 */
export function threadProfile(store: Store, req: Request): ThreadProfile {
  const thread = threadRequests(store, req);
  const key = `${store.version}:${req.sessionId}:${req.agentId ?? ''}`;
  const hit = profiles.get(key);
  if (hit && hit.index.has(req.id)) return hit;
  const steps: Step[] = thread.map((r, i) => {
    let chars = 0;
    for (const rec of store.chain(r.file, r.firstUuid)) for (const p of rec.pieces) chars += p.chars;
    return { id: r.id, ts: r.ts, measured: r.contextTokens, chars, after: i > 0 ? thread[i - 1].tools : [] };
  });
  const ratios: number[] = [];
  for (let i = 1; i < steps.length; i++) {
    const dm = steps[i].measured - steps[i - 1].measured;
    const dc = steps[i].chars - steps[i - 1].chars;
    if (dm > 200 && dc > 500) {
      const r = dc / dm;
      if (r > 0.8 && r < 8) ratios.push(r);
    }
  }
  const charsPerToken = ratios.length >= 3 ? median(ratios) : DEFAULT_CHARS_PER_TOKEN;
  const first = steps[0];
  const baseline = first ? Math.max(0, Math.round(first.measured - first.chars / charsPerToken)) : 0;
  const profile = { charsPerToken, baseline, steps, index: new Map(steps.map((s, i) => [s.id, i])) };
  for (const k of profiles.keys()) if (!k.startsWith(`${store.version}:`)) profiles.delete(k);
  profiles.set(key, profile);
  return profile;
}

/** `diff: false` skips the "added this turn" comparison (one fewer chain walk) for bulk use. */
export function attribute(store: Store, requestId: string, opts: { diff?: boolean } = {}): Attribution | undefined {
  const req = store.requests.get(requestId);
  if (!req) return undefined;
  const prof = threadProfile(store, req);
  const pos = prof.index.get(req.id) ?? 0;
  const cpt = prof.charsPerToken;
  const chain = store.chain(req.file, req.firstUuid);
  const pieces = piecesOf(chain);
  const total = req.contextTokens;
  const baseline = Math.min(prof.baseline, total);
  const chars = pieces.reduce((a, p) => a + p.piece.chars, 0);
  const room = total - baseline;
  // Visible content at the calibrated rate, squeezed only if it would overflow the measurement.
  const visibleTokens = Math.min(Math.round(chars / cpt), room);
  const unattributed = room - visibleTokens;
  const alloc = apportion(visibleTokens, pieces.map((p) => p.piece.chars));

  const prevStep = pos > 0 ? prof.steps[pos - 1] : undefined;
  const prevIds = new Set<string>();
  if (prevStep && opts.diff !== false) {
    const prev = store.requests.get(prevStep.id)!;
    for (const { rec, piece } of piecesOf(store.chain(prev.file, prev.firstUuid))) prevIds.add(`${rec.uuid}:${piece.block}`);
  }

  const items: ContextItem[] = [
    {
      id: 'baseline',
      uuid: '',
      block: 0,
      kind: 'baseline',
      label: 'System prompt + tool definitions',
      detail: 'Not written to the transcript; measured once on the first request of this thread',
      chars: 0,
      tokens: baseline,
      added: pos === 0,
      ts: prof.steps[0]?.ts ?? req.ts,
    },
  ];

  // Unexplained growth, step by step (signed): a big jump is named where it happened (e.g. after a
  // ToolSearch loaded schemas); the rest is estimation variance, shown as one line. Keeping the sign
  // matters: dropping the negative steps lets positive noise pile up and drown the real jumps.
  if (unattributed > 0) {
    const floor = Math.max(500, total * 0.005);
    const named: { step: Step; tokens: number }[] = [];
    for (let i = 1; i <= pos; i++) {
      const s = prof.steps[i];
      const p = prof.steps[i - 1];
      const jump = s.measured - p.measured - (s.chars - p.chars) / cpt;
      if (jump >= floor) named.push({ step: s, tokens: jump });
    }
    const namedSum = named.reduce((a, n) => a + n.tokens, 0);
    const namedAlloc = apportion(Math.min(Math.round(namedSum), unattributed), named.map((n) => n.tokens));
    named.forEach((n, i) => {
      if (!namedAlloc[i]) return;
      items.push({
        id: `unattributed:${n.step.id}`,
        uuid: '',
        block: 0,
        kind: 'unattributed',
        label: n.step.after.length ? `Not in transcript: appeared after ${n.step.after.join(', ')}` : 'Not in transcript: appeared at this step',
        detail: 'Tool schemas loaded mid-session (ToolSearch, MCP, skills), hidden thinking, or tokenizer variance',
        chars: 0,
        tokens: namedAlloc[i],
        added: n.step.id === req.id,
        ts: n.step.ts,
      });
    });
    const rest = unattributed - namedAlloc.reduce((a, b) => a + b, 0);
    if (rest > 0)
      items.push({
        id: 'unattributed:rest',
        uuid: '',
        block: 0,
        kind: 'unattributed',
        label: named.length ? 'Not in transcript: estimation variance' : 'Not in transcript',
        detail: 'Hidden content and chars-per-token variance spread over many requests',
        chars: 0,
        tokens: rest,
        added: pos === 0,
        ts: req.ts,
      });
  }

  pieces.forEach(({ rec, piece }, i) => {
    const id = `${rec.uuid}:${piece.block}`;
    items.push({
      id,
      uuid: rec.uuid,
      block: piece.block,
      kind: piece.kind,
      label: piece.label,
      detail: piece.detail,
      chars: piece.chars,
      tokens: alloc[i],
      added: prevStep ? !prevIds.has(id) : true,
      ts: rec.ts,
      toolName: piece.toolName,
    });
  });

  // Output: the response's own blocks, sharing the measured output tokens.
  const outRecs = req.uuids.map((u) => store.record(req.file, u)).filter((r): r is Rec => !!r);
  const outPieces = piecesOf(outRecs);
  const outAlloc = new Array<number>(outPieces.length).fill(0);
  const thinkingIdx = outPieces.flatMap((p, i) => (p.piece.kind === 'thinking' ? [i] : []));
  const restIdx = outPieces.flatMap((p, i) => (p.piece.kind === 'thinking' ? [] : [i]));
  // Thinking tokens are reported separately; the thinking text itself is usually not stored.
  const thinkTokens = thinkingIdx.length ? Math.min(req.usage.thinking, req.usage.output) : 0;
  apportion(thinkTokens, thinkingIdx.map(() => 1)).forEach((t, k) => (outAlloc[thinkingIdx[k]] = t));
  apportion(
    req.usage.output - thinkTokens,
    restIdx.map((i) => outPieces[i].piece.chars || 1),
  ).forEach((t, k) => (outAlloc[restIdx[k]] = t));
  const output: OutputItem[] = outPieces.map(({ rec, piece }, i) => ({
    id: `${rec.uuid}:${piece.block}`,
    uuid: rec.uuid,
    block: piece.block,
    kind: piece.kind,
    label: piece.label,
    detail: piece.detail,
    chars: piece.chars,
    tokens: outAlloc[i],
  }));

  return {
    requestId: req.id,
    measuredInput: total,
    baselineTokens: baseline,
    unattributedTokens: unattributed,
    items,
    output,
    previousRequestId: prevStep?.id,
    addedTokens: items.filter((i) => i.added).reduce((a, i) => a + i.tokens, 0),
    charsPerToken: cpt,
  };
}

export interface CompositionPoint {
  id: string;
  ts: number;
  agentId?: string;
  total: number;
  contextLimit: number;
  /** Measured input split by item kind; always sums to `total`. */
  byKind: Partial<Record<ItemKind, number>>;
}

const compositions = new Map<string, CompositionPoint[]>();

/** What filled the context on every request of a session (main thread and subagents). */
export function sessionComposition(store: Store, sessionId: string): CompositionPoint[] {
  const key = `${store.version}:${sessionId}`;
  const hit = compositions.get(key);
  if (hit) return hit;
  const s = store.sessions.get(sessionId);
  if (!s) return [];
  const out: CompositionPoint[] = [];
  for (const req of store.sessionRequests(s)) {
    const a = attribute(store, req.id, { diff: false });
    if (!a) continue;
    const byKind: Partial<Record<ItemKind, number>> = {};
    for (const i of a.items) byKind[i.kind] = (byKind[i.kind] ?? 0) + i.tokens;
    out.push({ id: req.id, ts: req.ts, agentId: req.agentId, total: a.measuredInput, contextLimit: req.contextLimit, byKind });
  }
  for (const k of compositions.keys()) if (!k.startsWith(`${store.version}:`)) compositions.delete(k);
  compositions.set(key, out);
  return out;
}
