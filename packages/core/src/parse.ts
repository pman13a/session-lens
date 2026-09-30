import { basename, dirname } from 'node:path';
import type { ContentPiece, FileIndex, Rec, Usage } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const IMAGE_CHARS = 6000; // ~1.5k tokens: images carry no text but occupy context

export function textOf(content: Json): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n');
  return typeof content.text === 'string' ? content.text : '';
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** The field of a tool call's input that tells you what it touched. */
export function toolDetail(name: string, input: Json): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const pick =
    input.file_path ??
    input.notebook_path ??
    input.path ??
    input.url ??
    input.pattern ??
    input.query ??
    input.description ??
    input.command ??
    input.prompt ??
    input.skill ??
    Object.values(input).find((v) => typeof v === 'string');
  return typeof pick === 'string' ? oneLine(pick, 120) : undefined;
}

export function parseUsage(u: Json): Usage {
  const cc = u?.cache_creation;
  const write = u?.cache_creation_input_tokens ?? 0;
  const w1h = cc?.ephemeral_1h_input_tokens ?? 0;
  const w5m = cc ? cc.ephemeral_5m_input_tokens ?? Math.max(write - w1h, 0) : write;
  return {
    input: u?.input_tokens ?? 0,
    cacheWrite5m: w5m,
    cacheWrite1h: w1h,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    thinking: u?.output_tokens_details?.thinking_tokens ?? 0,
    webSearches: u?.server_tool_use?.web_search_requests ?? 0,
  };
}

function userPieces(d: Json, toolNames: Map<string, { name: string; detail?: string }>): ContentPiece[] {
  const c = d.message?.content;
  const pieces: ContentPiece[] = [];
  const human = d.origin?.kind === 'human' || d.turnOrigin === 'human';
  const kindForText = d.isCompactSummary ? 'compact_summary' : d.isMeta || !human ? 'meta' : 'prompt';
  if (typeof c === 'string') {
    pieces.push({ kind: kindForText, label: oneLine(c, 80) || '(empty)', chars: c.length, block: 0 });
    return pieces;
  }
  if (!Array.isArray(c)) return pieces;
  c.forEach((b: Json, i: number) => {
    if (b?.type === 'text') {
      pieces.push({ kind: kindForText, label: oneLine(b.text ?? '', 80), chars: (b.text ?? '').length, block: i });
    } else if (b?.type === 'tool_result') {
      const src = toolNames.get(b.tool_use_id);
      const inner = b.content;
      let chars = 0;
      let images = 0;
      if (typeof inner === 'string') chars = inner.length;
      else if (Array.isArray(inner))
        for (const x of inner) {
          if (x?.type === 'image') images++;
          else chars += (x?.text ?? JSON.stringify(x)).length;
        }
      pieces.push({
        kind: 'tool_result',
        label: src?.name ?? 'tool result',
        detail: src?.detail,
        chars: chars + images * IMAGE_CHARS,
        block: i,
        toolUseId: b.tool_use_id,
        toolName: src?.name,
      });
    } else if (b?.type === 'image') {
      pieces.push({ kind: 'image', label: 'image', chars: IMAGE_CHARS, block: i });
    } else if (b?.type === 'document') {
      const len = JSON.stringify(b.source ?? {}).length;
      pieces.push({ kind: 'attachment', label: 'document', chars: len, block: i });
    }
  });
  return pieces;
}

function assistantPieces(d: Json, toolNames: Map<string, { name: string; detail?: string }>): ContentPiece[] {
  const c = d.message?.content;
  if (!Array.isArray(c)) return [];
  const pieces: ContentPiece[] = [];
  c.forEach((b: Json, i: number) => {
    if (b?.type === 'text') {
      pieces.push({ kind: 'text', label: oneLine(b.text ?? '', 80) || '(empty)', chars: (b.text ?? '').length, block: i });
    } else if (b?.type === 'thinking' || b?.type === 'redacted_thinking') {
      const t = b.thinking ?? '';
      pieces.push({ kind: 'thinking', label: t ? oneLine(t, 80) : 'thinking (not displayed)', chars: t.length, block: i });
    } else if (b?.type === 'tool_use' || b?.type === 'server_tool_use') {
      const detail = toolDetail(b.name, b.input);
      toolNames.set(b.id, { name: b.name, detail });
      pieces.push({
        kind: 'tool_use',
        label: b.name,
        detail,
        chars: (b.name?.length ?? 0) + JSON.stringify(b.input ?? {}).length,
        block: i,
        toolUseId: b.id,
        toolName: b.name,
      });
    } else if (typeof b?.type === 'string' && b.type.endsWith('_tool_result')) {
      pieces.push({ kind: 'tool_result', label: b.type, chars: JSON.stringify(b.content ?? '').length, block: i });
    }
  });
  return pieces;
}

function attachmentPieces(d: Json): ContentPiece[] {
  const r = d.rendered;
  if (!Array.isArray(r) || r.length === 0) return [];
  const text = r.map((x: Json) => x?.content ?? '').join('\n');
  if (!text) return [];
  const type = d.attachment?.type ?? 'attachment';
  return [{ kind: 'attachment', label: type, detail: oneLine(text.replace(/<\/?system-reminder>/g, ''), 100), chars: text.length, block: 0 }];
}

/** Skill tool calls, and `/name` commands typed by the user (`<command-name>/name</command-name>`). */
function skillsIn(d: Json, rec: Rec): string[] {
  const out: string[] = [];
  if (rec.type === 'assistant') {
    for (const p of rec.pieces) if (p.kind === 'tool_use' && p.label === 'Skill' && p.detail) out.push(p.detail);
  } else if (rec.type === 'user') {
    const text = textOf(d.message?.content);
    for (const m of text.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)) out.push(m[1]);
  }
  return out;
}

export interface FileLocation {
  sessionId: string;
  agentId?: string;
}

/** `<project>/<session>.jsonl` or `<project>/<session>/subagents/agent-<id>.jsonl`. */
export function locate(path: string): FileLocation {
  const name = basename(path, '.jsonl');
  if (basename(dirname(path)) === 'subagents') {
    return { sessionId: basename(dirname(dirname(path))), agentId: name.replace(/^agent-/, '') };
  }
  return { sessionId: name };
}

export interface AgentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
}

/**
 * Builds a FileIndex from transcript lines, one at a time, so a live file can be followed by feeding
 * only what was appended. Each record keeps its byte range for reading the raw line back later.
 */
export class TranscriptParser {
  readonly idx: FileIndex;
  private toolNames = new Map<string, { name: string; detail?: string }>();
  private seen = new Set<string>();
  private firstPrompt?: string;
  private titled = false;

  constructor(path: string, stat: { mtimeMs: number; size: number }, meta?: AgentMeta) {
    const loc = locate(path);
    this.idx = {
      path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sessionId: loc.sessionId,
      agentId: loc.agentId,
      agentType: meta?.agentType,
      agentDescription: meta?.description,
      agentToolUseId: meta?.toolUseId,
      firstTs: 0,
      lastTs: 0,
      records: [],
    };
  }

  /** One complete JSONL line and where it sits in the file (bytes). */
  feed(raw: string, offset: number, len: number): void {
    const idx = this.idx;
    if (!raw.trim()) return;
    let d: Json;
    try {
      d = JSON.parse(raw);
    } catch {
      return; // a torn line; the tail reader only feeds complete ones, so this is real corruption
    }
    const type = d.type;
    if (type === 'ai-title' && d.aiTitle) {
      idx.title = d.aiTitle;
      this.titled = true;
    } else if (type === 'custom-title' && d.customTitle) {
      idx.title = d.customTitle;
      this.titled = true;
    } else if (type === 'summary' && d.summary && !this.titled) {
      idx.title = d.summary;
      this.titled = true;
    } else if (type === 'cost-state' && typeof d.totalCostUSD === 'number') {
      idx.reportedCostUSD = d.totalCostUSD;
      // Claude Code's own running total at this point in the file: a checkpoint to reconcile against.
      idx.costCheckpoint = { totalUSD: d.totalCostUSD, recordCount: idx.records.length, ts: idx.lastTs };
    }
    if (type !== 'user' && type !== 'assistant' && type !== 'attachment' && type !== 'system') return;
    if (!d.uuid || this.seen.has(d.uuid)) return;
    this.seen.add(d.uuid);
    const ts = Date.parse(d.timestamp);
    if (!Number.isFinite(ts)) return;
    if (!idx.cwd && d.cwd) idx.cwd = d.cwd;
    idx.firstTs = idx.firstTs ? Math.min(idx.firstTs, ts) : ts;
    idx.lastTs = Math.max(idx.lastTs, ts);
    const rec: Rec = {
      uuid: d.uuid,
      parentUuid: d.parentUuid ?? null,
      type,
      ts,
      offset,
      len,
      promptId: d.promptId,
      entrypoint: d.entrypoint,
      pieces: [],
    };
    if (type === 'user') {
      rec.isMeta = !!d.isMeta;
      rec.isHuman = d.origin?.kind === 'human' || d.turnOrigin === 'human';
      if (typeof d.origin?.kind === 'string') rec.origin = d.origin.kind;
      rec.pieces = userPieces(d, this.toolNames);
      if (!this.firstPrompt && rec.isHuman && !rec.isMeta) {
        this.firstPrompt = textOf(d.message?.content);
        if (!this.titled && this.firstPrompt) idx.title = oneLine(this.firstPrompt, 90);
      }
    } else if (type === 'assistant') {
      const m = d.message ?? {};
      rec.model = m.model;
      rec.requestId = d.requestId ?? (m.model === '<synthetic>' ? undefined : m.id);
      if (m.usage && m.model !== '<synthetic>') rec.usage = parseUsage(m.usage);
      rec.pieces = assistantPieces(d, this.toolNames);
      rec.stopReason = m.stop_reason ?? undefined;
    } else if (type === 'attachment') {
      rec.pieces = attachmentPieces(d);
    }
    const skills = skillsIn(d, rec);
    if (skills.length) rec.skills = skills;
    idx.records.push(rec);
  }
}

/** Parse a whole transcript held in memory (tests, one-off reads). */
export function parseTranscript(path: string, text: string, stat: { mtimeMs: number; size: number }, meta?: AgentMeta): FileIndex {
  const p = new TranscriptParser(path, stat, meta);
  let offset = 0;
  for (const line of text.split('\n')) {
    const len = Buffer.byteLength(line);
    p.feed(line, offset, len);
    offset += len + 1;
  }
  return p.idx;
}

/** Raw text of one content block, for the "show me what this was" view. */
export function blockText(line: string, block: number): string {
  const d: Json = JSON.parse(line);
  if (d.type === 'attachment') return (d.rendered ?? []).map((x: Json) => x?.content ?? '').join('\n');
  const c = d.message?.content;
  if (typeof c === 'string') return c;
  const b = Array.isArray(c) ? c[block] : undefined;
  if (!b) return '';
  switch (b.type) {
    case 'text':
      return b.text ?? '';
    case 'thinking':
      return b.thinking || '(thinking content is not stored in the transcript)';
    case 'redacted_thinking':
      return '(redacted thinking)';
    case 'tool_use':
    case 'server_tool_use':
      return `${b.name}\n${JSON.stringify(b.input, null, 2)}`;
    case 'tool_result':
      return typeof b.content === 'string'
        ? b.content
        : (b.content ?? []).map((x: Json) => (x?.type === 'image' ? '[image]' : x?.text ?? JSON.stringify(x))).join('\n');
    case 'image':
      return '[image]';
    default:
      return JSON.stringify(b, null, 2);
  }
}
