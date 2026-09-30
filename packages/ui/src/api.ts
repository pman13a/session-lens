/* Transport: plain fetch over HTTP, or a postMessage bridge inside a VS Code webview. */

export interface Usage {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  thinking: number;
  webSearches: number;
}

export interface DayRow {
  day: string;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  cost: number;
  requests: number;
  sessions: number;
  costByModel: Record<string, number>;
  costParts: CostParts;
}

export interface CostParts {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** Day totals only: side calls reconciled from Claude Code's own tally. */
  side?: number;
}

export interface Summary {
  days: DayRow[];
  totals: { input: number; cacheWrite: number; cacheRead: number; output: number; cost: number; requests: number; sessions: number };
  projects: string[];
  models: string[];
  range: { first?: string; last?: string };
  discount: number;
  unknownModels: string[];
  unpricedRequests: number;
  sideCost: number;
  byRole: RoleSplit;
  history: { oldestDay?: string; retentionDays: number; keptSince: string };
  live: { id: string; title: string; project?: string; entrypoint?: string; pid: number; lastTs: number; cost: number; contextTokens: number; contextLimit: number; requests: number }[];
}

export interface SessionRow {
  id: string;
  project: string;
  title: string;
  firstTs: number;
  lastTs: number;
  models: string[];
  requests: number;
  subagents: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  cost: number;
  totalCost: number;
  peakContext: number;
  peakContextPct: number;
  spark: number[];
  live: boolean;
  byRole: RoleSplit;
}

export type RequestRole = 'prompt' | 'iteration' | 'answer' | 'subagent' | 'auto';
export type ItemOrigin = 'you' | 'claude' | 'tool' | 'subagent' | 'system';
export type RoleSplit = Partial<Record<RequestRole, { requests: number; cost: number; output: number }>>;

export interface RequestRow {
  id: string;
  ts: number;
  day: string;
  model: string;
  agentId?: string;
  usage: Usage;
  cost: number;
  costParts: CostParts;
  priced?: boolean;
  /** This request's share of side calls reconciled from Claude Code's own tally. */
  side?: number;
  contextTokens: number;
  contextLimit: number;
  tools: string[];
  promptId?: string;
  stopReason?: string;
  role: RequestRole;
  trigger?: string[];
}

export interface SubagentRow {
  agentId: string;
  agentType?: string;
  description?: string;
  launchedBy?: string;
  requests: number;
  cost: number;
  firstTs: number;
  model?: string;
}

export interface SessionDetail {
  session: {
    id: string;
    project: string;
    cwd?: string;
    title: string;
    firstTs: number;
    lastTs: number;
    reportedCostUSD?: number;
    cost: number;
    sideCost: number;
    checkpoint?: { claudeCodeUSD: number; transcriptUSD: number; ts: number };
    live: boolean;
    unpriced: number;
    byRole: RoleSplit;
  };
  requests: RequestRow[];
  turns: { promptId: string; text: string; ts: number; requestIds: string[]; cost: number; output: number; byRole: RoleSplit }[];
  subagents: SubagentRow[];
}

export type ItemKind =
  | 'baseline'
  | 'unattributed'
  | 'prompt'
  | 'meta'
  | 'compact_summary'
  | 'attachment'
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'image';

export interface ContextItem {
  id: string;
  uuid: string;
  block: number;
  kind: ItemKind;
  label: string;
  detail?: string;
  chars: number;
  tokens: number;
  added: boolean;
  ts: number;
  toolName?: string;
  origin: ItemOrigin;
}

export interface RequestDetail {
  request: Omit<RequestRow, 'day' | 'promptId'> & {
    launched: { agentId: string; agentType?: string; description?: string; requests: number; cost: number; firstRequestId?: string }[];
    subagent?: { agentType?: string; description?: string; launchedBy?: string };
  };
  session?: { id: string; title: string; project: string };
  thread: { index: number; count: number; prev?: string; next?: string };
  attribution: {
    requestId: string;
    measuredInput: number;
    baselineTokens: number;
    unattributedTokens: number;
    items: ContextItem[];
    output: { id: string; uuid: string; block: number; kind: ItemKind; label: string; detail?: string; chars: number; tokens: number }[];
    previousRequestId?: string;
    addedTokens: number;
    charsPerToken: number;
  };
}

export type BillingMode = 'api' | 'subscription' | 'team';

export interface AccountState {
  account: { source: string; loggedIn: boolean; authMethod?: string; subscriptionType?: string | null; orgName?: string | null; email?: string | null; detected: BillingMode; label: string };
  mode: BillingMode;
  overridden: boolean;
  /** Plan fee in effect: typed under Plan…, else implied by the detected plan (Max 5×/20×, Pro). */
  planPrice: number | null;
  planPriceSource: 'settings' | 'plan' | null;
  settings: { billing: BillingMode | 'auto'; planPrice: number | null; monthlyLimit: number | null; periodStartDay: number; discount: number };
  period: { start: string; end: string; days: number; daysElapsed: number; cost: number; projected: number };
}

export interface CompositionPoint {
  id: string;
  ts: number;
  agentId?: string;
  total: number;
  contextLimit: number;
  byKind: Partial<Record<ItemKind, number>>;
  byOrigin: Partial<Record<ItemOrigin, number>>;
  role: RequestRole;
}

export interface UsageSeries {
  key: string;
  label: string;
  values: number[];
  total: number;
  share: number;
  prior: number;
  change: number | null;
  requests: number;
  local: boolean;
}

export interface UsageView {
  range: { from: string; to: string; days: number; prior: { from: string; to: string; incomplete: boolean }; timeZone: string };
  history: { oldestDay?: string; keptSince: string; retentionDays: number };
  group: 'product' | 'model' | 'project' | 'surface' | 'role';
  interval: 'day' | 'week';
  buckets: string[];
  series: UsageSeries[];
  total: number;
  period: { start: string; end: string; resetsAt: string; spent: number; limit: number | null };
  skills: { name: string; uses: number; sessions: number }[];
  skillsThrough: string;
  /** Charges beyond top-level token counts, in range (already included in the totals). */
  billed: Record<'compaction' | 'fast' | 'usOnly', { requests: number; cost: number }>;
  reference: {
    period: { spent?: number; limit?: number };
    range: Partial<Record<'claude_code' | 'chat' | 'cowork' | 'chrome', number>>;
    rangeKey: string;
    days: Record<string, number>;
  };
}

export type PriceSource = 'bundled' | 'anthropic' | 'custom';
export interface PriceRow {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  context: number;
}
export interface PricingInfo {
  checkedAt?: string;
  sourceUrl?: string;
  webSearchPerRequest: number;
  appliedFromAnthropic?: string;
  models: { id: string; price: PriceRow; source: PriceSource; bundled?: PriceRow; edited: Partial<PriceRow> | null; usage: { requests: number; lastTs: number; ids: string[] } | null }[];
  unpriced: { model: string; requests: number; lastTs: number }[];
  discount: number;
  modelDiscounts: Record<string, number>;
}
export interface PublishedCheck {
  fetchedAt: string;
  url: string;
  models: (Omit<PriceRow, 'context'> & { id: string; name: string; note?: string; status: 'new' | 'changed' | 'same'; changed: string[]; current?: PriceRow; source: PriceSource | null })[];
}
export interface ConfigInfo {
  roots: string[];
  configDirs: string[];
  retentionDays: number;
  settingsPath: string;
  timeZone: string | null;
  systemTimeZone: string;
  transcripts: number;
  sessions: number;
  requests: number;
  live: number;
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
/** What the Electron preload exposes: IPC instead of a local web server. */
interface DesktopBridge {
  api(path: string, query: string, body?: unknown): Promise<unknown>;
  onChange(cb: () => void): void;
  save(name: string, content: string): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
    sessionLens?: DesktopBridge;
  }
}

let vscode: VsCodeApi | undefined;
const pending = new Map<number, (v: unknown) => void>();
let seq = 0;
if (typeof window.acquireVsCodeApi === 'function') {
  vscode = window.acquireVsCodeApi();
  window.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as { type?: string; id?: number; body?: unknown };
    if (m?.type === 'api:result' && typeof m.id === 'number') {
      pending.get(m.id)?.(m.body);
      pending.delete(m.id);
    }
  });
}

export async function api<T>(path: string, params: Record<string, string | undefined> = {}, post?: unknown): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  let body: unknown;
  if (vscode) {
    const id = ++seq;
    body = await new Promise((resolve) => {
      pending.set(id, resolve);
      vscode!.postMessage({ type: 'api', id, path, query: qs.toString(), body: post });
    });
  } else if (window.sessionLens) {
    body = await window.sessionLens.api(path, qs.toString(), post);
  } else {
    const res = await fetch(
      `./api/${path}?${qs}`,
      post === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(post) },
    );
    body = await res.json();
  }
  if (body && typeof body === 'object' && 'error' in body) throw new Error(String((body as { error: unknown }).error));
  return body as T;
}

/** Save a file: a save dialog in VS Code, a download elsewhere. */
export function saveFile(name: string, content: string, mime: string) {
  if (vscode) {
    vscode.postMessage({ type: 'save', name, content });
    return;
  }
  if (window.sessionLens) {
    window.sessionLens.save(name, content);
    return;
  }
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Hear about new data as it lands: server-sent events over HTTP, a message from the VS Code extension,
 * or an IPC event in the desktop app. `onState` reports whether the live link is up.
 */
export function subscribe(onChange: () => void, onState: (state: 'live' | 'offline') => void) {
  if (vscode) {
    window.addEventListener('message', (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === 'change') onChange();
    });
    onState('live');
    return;
  }
  if (window.sessionLens) {
    window.sessionLens.onChange(onChange);
    onState('live');
    return;
  }
  if (typeof EventSource === 'undefined') return onState('offline');
  const es = new EventSource('./api/events');
  es.addEventListener('change', () => onChange());
  // Reconnecting after a drop may have missed changes: catch up once it is back.
  let wasDown = false;
  es.onopen = () => {
    onState('live');
    if (wasDown) onChange();
    wasDown = false;
  };
  es.onerror = () => {
    wasDown = true;
    onState('offline');
  };
}
