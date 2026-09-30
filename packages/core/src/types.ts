/** Token counts for one API request, exactly as the transcript reports them. */
export interface Usage {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  thinking: number;
  webSearches: number;
}

export type ItemKind =
  | 'baseline' // system prompt + tool definitions (never written to the transcript)
  | 'unattributed' // context growth the transcript can't explain: tool schemas loaded mid-session, hidden thinking
  | 'prompt' // a human-typed message
  | 'meta' // harness-injected user text (continue prompts, command output)
  | 'compact_summary'
  | 'attachment' // system reminders, environment snapshots, skill listings...
  | 'text' // assistant text
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'image';

/** One piece of transcript content, measured in characters. */
export interface ContentPiece {
  kind: ItemKind;
  /** Short human label: tool name, attachment type, first words of a prompt. */
  label: string;
  /** Secondary detail: file path, command, url. */
  detail?: string;
  chars: number;
  /** Index of the block within the record, used to fetch raw content. */
  block: number;
  toolUseId?: string;
  toolName?: string;
}

/** A transcript line reduced to what the index needs. Raw text is re-read on demand. */
export interface Rec {
  uuid: string;
  parentUuid: string | null;
  type: 'user' | 'assistant' | 'attachment' | 'system';
  ts: number;
  /** Byte range of the raw JSONL line, for reading it back on demand. */
  offset: number;
  len: number;
  promptId?: string;
  requestId?: string;
  model?: string;
  usage?: Usage;
  stopReason?: string;
  /** Which Claude Code surface wrote the record: cli, claude-vscode, claude-desktop, remote_mobile, sdk-… */
  entrypoint?: string;
  /** Skills invoked here: Skill tool calls, or a /slash command typed by the user. */
  skills?: string[];
  isMeta?: boolean;
  isHuman?: boolean;
  pieces: ContentPiece[];
}

export interface FileIndex {
  path: string;
  mtimeMs: number;
  size: number;
  sessionId: string;
  /** Set for subagent transcripts (<session>/subagents/agent-<id>.jsonl). */
  agentId?: string;
  agentType?: string;
  agentDescription?: string;
  agentToolUseId?: string;
  cwd?: string;
  title?: string;
  firstTs: number;
  lastTs: number;
  records: Rec[];
  /** Claude Code's own running cost for the session, when it wrote one. */
  reportedCostUSD?: number;
  /** The last such record, with how many records preceded it: used to reconcile. */
  costCheckpoint?: { totalUSD: number; recordCount: number; ts: number };
}

export interface Price {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  context: number;
}

export interface Request {
  id: string;
  sessionId: string;
  agentId?: string;
  file: string;
  ts: number;
  model: string;
  usage: Usage;
  /** Dollars for this request's own tokens (0 when the model has no known price). */
  cost: number;
  /** Its share of side calls reconciled from Claude Code's own tally (see Store.reconcile). */
  side: number;
  /** False for a model with no price on file: tokens count, dollars do not. */
  priced: boolean;
  /** Tokens occupying the context window for this call: input + cache read + cache write. */
  contextTokens: number;
  contextLimit: number;
  /** First and last transcript records of this request (one response is split across several). */
  firstUuid: string;
  uuids: string[];
  promptId?: string;
  /** Tools the response called. */
  tools: string[];
  stopReason?: string;
  entrypoint?: string;
}

export interface SubagentInfo {
  agentId: string;
  agentType?: string;
  description?: string;
  toolUseId?: string;
  requestIds: string[];
}

export interface Session {
  id: string;
  project: string;
  cwd?: string;
  title: string;
  firstTs: number;
  lastTs: number;
  mainFile?: string;
  files: string[];
  requestIds: string[];
  subagents: SubagentInfo[];
  reportedCostUSD?: number;
  /** Side calls: Claude Code's own tally minus what the transcript records add up to, at the last checkpoint. */
  sideCost: number;
  checkpoint?: { claudeCodeUSD: number; transcriptUSD: number; ts: number };
}

export interface Totals {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  cost: number;
  requests: number;
}

/** How usage turns into money: pay per token, a flat subscription, or a Team/Enterprise seat. */
export type BillingMode = 'api' | 'subscription' | 'team';

export interface Settings {
  /** Override the detected billing mode. Unset = follow the logged-in account. */
  billing?: BillingMode;
  /** Monthly subscription fee in USD (Pro/Max), to compare API-equivalent value against. */
  planPrice?: number;
  /** Monthly spend limit in USD (Team/Enterprise allowance, or your own API budget). */
  monthlyLimit?: number;
  /** Day of the month the billing period starts (1–28). */
  periodStartDay?: number;
  /** Fraction taken off every cost, e.g. 0.1 for a 10% negotiated discount. */
  discount?: number;
  /** Per-model discounts by id prefix (longest wins), for contracts that price models differently. */
  modelDiscounts?: Record<string, number>;
  /** The user's own price edits, merged over everything else, keyed by model id prefix. */
  prices?: Record<string, Partial<Price>>;
  /** Prices applied from Anthropic's pricing page (Settings → Check Anthropic's prices), with when. */
  published?: { fetchedAt: string; models: Record<string, Omit<Price, 'context'> & { context?: number }> };
  /** IANA time zone used to bucket requests into days. Defaults to the system zone. */
  timeZone?: string;
}
