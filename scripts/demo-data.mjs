#!/usr/bin/env node
// Writes synthetic Claude Code transcripts (14 days, several projects, subagents) for trying the
// dashboard without real data:  node scripts/demo-data.mjs /tmp/demo && session-lens --projects /tmp/demo
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'demo-projects';
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const projects = ['web-shop', 'data-pipeline', 'mobile-app'];
const tools = [
  ['Read', () => ({ file_path: `/src/${pick(['api', 'db', 'ui', 'auth'])}/${pick(['index', 'routes', 'model', 'utils'])}.ts` }), () => 2000 + rnd() * 30000],
  ['Bash', () => ({ command: pick(['npm test', 'git status', 'npm run build', 'ls -la']), description: pick(['Run tests', 'Check status', 'Build', 'List files']) }), () => 300 + rnd() * 8000],
  ['Grep', () => ({ pattern: pick(['TODO', 'useEffect', 'fetchUser', 'SELECT']) }), () => 200 + rnd() * 3000],
  ['Edit', () => ({ file_path: `/src/${pick(['api', 'ui'])}/${pick(['index', 'form'])}.ts`, old_string: 'a', new_string: 'b' }), () => 150],
];
const prompts = ['Fix the failing login test', 'Add pagination to the orders page', 'Why is the nightly job slow?', 'Refactor the auth middleware', 'Write a migration for the new column', 'Review this PR for bugs'];

function session(project, day, hour) {
  const sid = uuid();
  const lines = [];
  let parent = null;
  let t = Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00`) + rnd() * 3.6e6;
  let context = 18000 + Math.round(rnd() * 4000);
  const model = pick(['claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  const push = (o) => {
    t += 2000 + rnd() * 20000;
    const u = uuid();
    lines.push({ uuid: u, parentUuid: parent, timestamp: new Date(t).toISOString(), sessionId: sid, cwd: `/home/dev/${project}`, ...o });
    parent = u;
    return u;
  };
  const subagents = [];
  const turns = 1 + Math.floor(rnd() * 4);
  for (let k = 0; k < turns; k++) {
    const promptId = uuid();
    const text = pick(prompts);
    push({ type: 'user', promptId, origin: { kind: 'human' }, message: { role: 'user', content: text } });
    context += Math.round(text.length / 2.3) + 400;
    const steps = 2 + Math.floor(rnd() * 9);
    for (let i = 0; i < steps; i++) {
      const req = `req_${uuid().slice(-12)}`;
      const [name, input, size] = pick(tools);
      const id = `toolu_${uuid().slice(-10)}`;
      const spawn = i === 1 && rnd() < 0.35;
      const block = spawn
        ? { type: 'tool_use', id, name: 'Agent', input: { description: 'Survey the codebase', prompt: 'Find where orders are paginated' } }
        : { type: 'tool_use', id, name, input: input() };
      const write = i === 0 ? 3000 + Math.round(rnd() * 2000) : 300 + Math.round(rnd() * 2500);
      const usage = { input_tokens: 3, cache_read_input_tokens: context - write, cache_creation_input_tokens: write, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write }, output_tokens: 80 + Math.round(rnd() * 900) };
      push({ type: 'assistant', requestId: req, message: { id: `msg_${req}`, model, role: 'assistant', content: [block], usage, stop_reason: 'tool_use' } });
      const resultChars = Math.round(size());
      push({ type: 'user', promptId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(resultChars) }] } });
      context += Math.round(resultChars / 2.3) + usage.output_tokens + 60;
      if (spawn) subagents.push({ toolUseId: id, t });
    }
    const req = `req_${uuid().slice(-12)}`;
    push({ type: 'assistant', requestId: req, message: { id: `msg_${req}`, model, role: 'assistant', content: [{ type: 'text', text: 'Done — the change is in place and tests pass.' }], usage: { input_tokens: 3, cache_read_input_tokens: context - 500, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 }, output_tokens: 120 }, stop_reason: 'end_turn' } });
  }
  lines.push({ type: 'ai-title', aiTitle: pick(prompts), sessionId: sid });
  const dir = join(out, `-home-dev-${project}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  for (const s of subagents) {
    const agentId = uuid().slice(-17).replace(/-/g, '');
    const sub = [];
    let p = null;
    let st = s.t;
    let ctx = 16000;
    for (let i = 0; i < 4; i++) {
      const u = uuid();
      st += 3000;
      const req = `req_${uuid().slice(-12)}`;
      if (i === 0) {
        sub.push({ uuid: u, parentUuid: null, isSidechain: true, agentId, type: 'user', promptId: uuid(), timestamp: new Date(st).toISOString(), sessionId: sid, message: { role: 'user', content: 'Find where orders are paginated' } });
        p = u;
        continue;
      }
      const a = uuid();
      sub.push({ uuid: a, parentUuid: p, isSidechain: true, agentId, type: 'assistant', requestId: req, timestamp: new Date(st).toISOString(), sessionId: sid, message: { id: `msg_${req}`, model: 'claude-haiku-4-5-20251001', role: 'assistant', content: [{ type: 'text', text: 'Searching…' }], usage: { input_tokens: 5, cache_read_input_tokens: ctx - 1500, cache_creation_input_tokens: 1500, output_tokens: 150 } } });
      p = a;
      ctx += 4000;
    }
    const sd = join(dir, sid, 'subagents');
    mkdirSync(sd, { recursive: true });
    writeFileSync(join(sd, `agent-${agentId}.jsonl`), sub.map((l) => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(join(sd, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'Explore', description: 'Survey the codebase', toolUseId: s.toolUseId }));
  }
}

const today = new Date();
for (let d = 13; d >= 0; d--) {
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - d);
  if (day.getDay() === 0) continue;
  const iso = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const count = 1 + Math.floor(rnd() * 5);
  for (let i = 0; i < count; i++) session(pick(projects), iso, 8 + Math.floor(rnd() * 10));
}
console.log(`Demo transcripts written to ${out}`);
