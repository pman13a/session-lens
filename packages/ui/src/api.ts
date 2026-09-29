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
}

export interface Summary {
  days: DayRow[];
  totals: { input: number; cacheWrite: number; cacheRead: number; output: number; cost: number; requests: number; sessions: number };
  projects: string[];
  models: string[];
  range: { first?: string; last?: string };
  discount: number;
  unknownModels: string[];
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
}

export interface RequestRow {
  id: string;
  ts: number;
  day: string;
  model: string;
  agentId?: string;
  usage: Usage;
  cost: number;
  costParts: CostParts;
  contextTokens: number;
  contextLimit: number;
  tools: string[];
  promptId?: string;
  stopReason?: string;
}

export interface SessionDetail {
  session: { id: string; project: string; cwd?: string; title: string; firstTs: number; lastTs: number; reportedCostUSD?: number; cost: number };
  requests: RequestRow[];
  turns: { promptId: string; text: string; ts: number; requestIds: string[]; cost: number; output: number }[];
  subagents: { agentId: string; agentType?: string; description?: string; requests: number; cost: number; firstTs: number; model?: string }[];
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
}

export interface RequestDetail {
  request: Omit<RequestRow, 'day' | 'promptId'>;
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

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare global {
  interface Window {
    acquireVsCodeApi?: () => VsCodeApi;
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

export async function api<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  let body: unknown;
  if (vscode) {
    const id = ++seq;
    body = await new Promise((resolve) => {
      pending.set(id, resolve);
      vscode!.postMessage({ type: 'api', id, path, query: qs.toString() });
    });
  } else {
    const res = await fetch(`./api/${path}?${qs}`);
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
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
