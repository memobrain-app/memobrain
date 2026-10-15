// Tests for the memobrain command line, run against the built dist/cli.js (build first).
//
// The fixtures are SYNTHETIC transcripts: hand-written records with invented text, in Claude
// Code's record format. demo.jsonl is a short working session (three typed prompts, a task
// notification, a hook block, a failed Edit, failing and passing test runs); variety.jsonl walks
// through the other tools, error classes and input channels. Every field of every skeleton line
// is recomputed here from the fixtures' raw records, without the parser, and compared with the
// output byte for byte.
//
// MEMOBRAIN_CLI=<path to a cli.js> runs the same tests against another build.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const CLI = process.env.MEMOBRAIN_CLI || join(root, 'dist', 'cli.js');
const fixture = (name) => join(here, 'fixtures', name);
const DEMO = fixture('demo.jsonl');
const VARIETY = fixture('variety.jsonl');
const BRANCHED = fixture('branched.jsonl');
const RETRIED = fixture('retried.jsonl');
const EDGES = fixture('edges.jsonl');
const AGENT = fixture('agent.jsonl');

function run(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const nonEmpty = (s) => s.split('\n').filter((l) => l !== '');
const parsed = (s) => nonEmpty(s).map((l) => JSON.parse(l));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- the fixtures, read directly, without the parser ---------------------------------------

// a line that is not JSON (branched.jsonl has one) is skipped here, as the parser skips it
const tryParse = (l) => { try { return JSON.parse(l); } catch { return undefined; } };
const recordsOf = (file) => readFileSync(file, 'utf8').split('\n')
  .flatMap((l, i) => { const rec = l.trim() ? tryParse(l) : undefined; return rec ? [{ line: i + 1, rec }] : []; });
const h12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('\n') : '');
const blocksIn = (rec) => (Array.isArray(rec.message?.content) ? rec.message.content : []);
function find(records, kind, id) {
  for (const { line, rec } of records) {
    for (const b of blocksIn(rec)) {
      if (kind === 'tool_use' && b.type === 'tool_use' && b.id === id) return { line, rec, block: b };
      if (kind === 'tool_result' && b.type === 'tool_result' && b.tool_use_id === id) return { line, rec, block: b };
    }
  }
  throw new Error(`no ${kind} for ${id}`);
}

// Known answers, read off the fixtures by hand: the live path's turns and calls, in order.
// demo.jsonl: line 21 (an isMeta record) opens no turn; lines 4 and 5 are one API response
// with two calls, whose results hang off different records (a fork that is not a rewind).
const DEMO_EXPECTED = [
  { k: 'turn', line: 2, ch: 'typed' },
  { k: 'call', id: 'toolu_demo_0001', tool: 'Bash', verb: 'ls' },
  { k: 'call', id: 'toolu_demo_0002', tool: 'Read', verb: 'README', ek: 'other' },
  { k: 'turn', line: 10, ch: 'typed' },
  { k: 'call', id: 'toolu_demo_0003', tool: 'Read', verb: '.txt' },
  { k: 'call', id: 'toolu_demo_0004', tool: 'Edit', verb: '.txt', ek: 'no-anchor' },
  { k: 'call', id: 'toolu_demo_0005', tool: 'Read', verb: '.txt' },
  { k: 'call', id: 'toolu_demo_0006', tool: 'Edit', verb: '.txt' },
  { k: 'turn', line: 20, ch: 'typed' },
  { k: 'call', id: 'toolu_demo_0007', tool: 'Bash', verb: 'rm', ek: 'hook-block:demo-gate' },
  { k: 'call', id: 'toolu_demo_0008', tool: 'Bash', verb: 'npm', ek: 'exit-1' },
  { k: 'call', id: 'toolu_demo_0009', tool: 'Bash', verb: 'npm', ek: 'exit-1' },
  { k: 'call', id: 'toolu_demo_0010', tool: 'Edit', verb: '.js' },
  { k: 'call', id: 'toolu_demo_0011', tool: 'Bash', verb: 'npm' },
  { k: 'turn', line: 33, ch: 'task' },
  { k: 'call', id: 'toolu_demo_0012', tool: 'Read', verb: '.log' },
];
// variety.jsonl has no last-prompt record, so its live path is the deepest leaf.
const VARIETY_EXPECTED = [
  { k: 'turn', line: 1, ch: 'sdk' },
  { k: 'call', id: 'toolu_variety_01', tool: 'Write', verb: '.csv' },
  { k: 'call', id: 'toolu_variety_02', tool: 'NotebookEdit', verb: '.ipynb' },
  { k: 'call', id: 'toolu_variety_03', tool: 'Agent', verb: 'demo-reviewer' },
  { k: 'call', id: 'toolu_variety_04', tool: 'Task', verb: 'agent' },
  { k: 'call', id: 'toolu_variety_05', tool: 'Skill', verb: 'demo-skill' },
  { k: 'call', id: 'toolu_variety_06', tool: 'WebSearch', verb: 'WebSearch' },
  { k: 'call', id: 'toolu_variety_07', tool: 'Bash', verb: 'demo-job.sh' },
  { k: 'turn', line: 17, ch: 'input' },
  { k: 'call', id: 'toolu_variety_08', tool: 'Edit', verb: '.txt', ek: 'not-read' },
  { k: 'call', id: 'toolu_variety_09', tool: 'Read', verb: '(none)', ek: 'bad-input' },
  { k: 'call', id: 'toolu_variety_10', tool: 'Bash', verb: 'sudo', ek: 'denied' },
  { k: 'call', id: 'toolu_variety_11', tool: 'Bash', verb: 'make', ek: 'other' },
  { k: 'call', id: 'toolu_variety_12', tool: 'Bash', verb: 'git', ek: 'hook-block' },
  { k: 'call', id: 'toolu_variety_13', tool: 'Bash', verb: '(empty)' },
];
// branched.jsonl: the second prompt (line 5) was rewound; its branch is DEEPER than the live one,
// and the last-prompt record points at the live leaf (line 16). Line 11 is blank and line 12 is a
// truncated record, so the addresses after them must stay physical line numbers.
const BRANCHED_EXPECTED = [
  { k: 'turn', line: 1, ch: 'typed' },
  { k: 'call', id: 'toolu_branched_01', tool: 'Bash', verb: 'ls' },
  { k: 'turn', line: 13, ch: 'typed' },
  { k: 'call', id: 'toolu_branched_04', tool: 'Write', verb: '.txt' },
];
// retried.jsonl: a request failed and was retried; the system:api_error record (line 7) was written
// AFTER the retried branch (lines 4 to 6) but parented before it, and the turn's last record (line 8)
// hangs off the error. The parent links alone route the live path around lines 4 to 6.
const RETRIED_EXPECTED = [
  { k: 'turn', line: 1, ch: 'typed' },
  { k: 'call', id: 'toolu_retried_01', tool: 'Bash', verb: 'npm' },
  { k: 'call', id: 'toolu_retried_02', tool: 'Bash', verb: 'npm' },
];
// edges.jsonl: a Read whose input is null; a failure with one verb at the end of a turn and a
// success with the same verb in the next one; a prompt whose promptSource (sdk) differs from what
// its entrypoint (cli) would imply.
const EDGES_EXPECTED = [
  { k: 'turn', line: 1, ch: 'typed' },
  { k: 'call', id: 'toolu_edges_01', tool: 'Read', verb: '(none)', ek: 'bad-input' },
  { k: 'call', id: 'toolu_edges_02', tool: 'Bash', verb: 'make', ek: 'exit-2' },
  { k: 'turn', line: 7, ch: 'sdk' },
  { k: 'call', id: 'toolu_edges_03', tool: 'Bash', verb: 'make' },
];
// agent.jsonl: a subagent's transcript (every record isSidechain): its prompt comes from the
// delegating agent, so its channel is "parent" and it is not counted among the prompts.
const AGENT_EXPECTED = [
  { k: 'turn', line: 1, ch: 'parent' },
  { k: 'call', id: 'toolu_agent_01', tool: 'Read', verb: '.js' },
];
const CASES = [
  { file: DEMO, sid: 'demo.jso', expected: DEMO_EXPECTED, minPayload: 56 },
  { file: VARIETY, sid: 'variety.', expected: VARIETY_EXPECTED, minPayload: 46 },
  { file: BRANCHED, sid: 'branched', expected: BRANCHED_EXPECTED, minPayload: 20,
    stderr: /^memobrain skeleton: warning: '[^']*branched\.jsonl': 1 line could not be read as a JSON object \(first: line 12\) and was skipped\.\n$/ },
  { file: RETRIED, sid: 'retried.', expected: RETRIED_EXPECTED, minPayload: 10 },
  { file: EDGES, sid: 'edges.js', expected: EDGES_EXPECTED, minPayload: 13 },
  { file: AGENT, sid: 'agent.js', expected: AGENT_EXPECTED, minPayload: 7 },
];

/** Every field of every expected line, computed from the raw records. */
function expectedSkeleton({ file, sid, expected }) {
  const records = recordsOf(file);
  let turn = 0;
  const ta = () => `${sid}:T${String(turn).padStart(3, '0')}`;
  return expected.map((e) => {
    if (e.k === 'turn') {
      turn++;
      const rec = records.find((r) => r.line === e.line).rec;
      return { k: 'turn', a: `${sid}:L${e.line}`, ta: ta(), ch: e.ch, n: textOf(rec.message.content).length };
    }
    const use = find(records, 'tool_use', e.id), res = find(records, 'tool_result', e.id);
    const text = textOf(res.block.content);
    return {
      k: 'call', a: `${sid}:L${use.line}`, ta: ta(), tool: e.tool, verb: e.verb,
      in: h12(JSON.stringify(use.block.input ?? {})), ok: !e.ek, ...(e.ek ? { ek: e.ek } : {}),
      r: `${sid}:L${res.line}`, out: h12(text), n: text.length,
    };
  });
}

// ---- the fixtures are what the known answers say they are ----------------------------------

test('fixtures: the calls marked failed are error results in the files, and only those', () => {
  const signals = [];
  for (const c of CASES) {
    const records = recordsOf(c.file);
    for (const e of c.expected.filter((x) => x.k === 'call')) {
      const res = find(records, 'tool_result', e.id);
      const flagged = res.block.is_error === true, errorForm = typeof res.rec.toolUseResult === 'string';
      assert.equal(flagged || errorForm, Boolean(e.ek), e.id);
      if (e.ek) signals.push(`${flagged ? 'flag' : ''}${errorForm ? '+string' : ''}`);
    }
  }
  // a failure is recorded by either signal alone: the fixtures carry each alone, and both together
  assert.deepEqual([...new Set(signals)].sort(), ['+string', 'flag', 'flag+string']);
  assert.ok(DEMO_EXPECTED.filter((x) => x.k === 'turn' && x.ch === 'typed').length >= 3, 'three typed prompts');
});

// ---- skeleton -------------------------------------------------------------------------------

for (const c of CASES) {
  test(`skeleton ${c.sid}: every field of every line, recomputed from the fixture`, () => {
    const r = run('skeleton', c.file);
    assert.equal(r.code, 0);
    if (c.stderr) assert.match(r.err, c.stderr); else assert.equal(r.err, '');
    assert.deepEqual(nonEmpty(r.out), expectedSkeleton(c).map((o) => JSON.stringify(o)));
    assert.ok(r.out.endsWith('\n'));
  });
}

test('skeleton: turns, calls and channels of the demo session', () => {
  const out = parsed(run('skeleton', DEMO).out);
  assert.equal(out.filter((o) => o.k === 'turn').length, 4);
  assert.equal(out.filter((o) => o.k === 'call').length, 12);
  assert.deepEqual(out.filter((o) => o.k === 'turn').map((o) => o.ch), ['typed', 'typed', 'typed', 'task']);
  assert.deepEqual(out.filter((o) => o.k === 'turn').map((o) => o.ta), ['demo.jso:T001', 'demo.jso:T002', 'demo.jso:T003', 'demo.jso:T004']);
});

test('skeleton: the failed calls, their addresses, their classes and the hook name', () => {
  const calls = parsed(run('skeleton', DEMO).out).filter((o) => o.k === 'call');
  assert.deepEqual(calls.filter((c) => !c.ok).map((c) => [c.a, c.r, c.tool, c.ek]), [
    ['demo.jso:L5', 'demo.jso:L7', 'Read', 'other'],
    ['demo.jso:L13', 'demo.jso:L14', 'Edit', 'no-anchor'],
    ['demo.jso:L22', 'demo.jso:L23', 'Bash', 'hook-block:demo-gate'],
    ['demo.jso:L24', 'demo.jso:L25', 'Bash', 'exit-1'],
    ['demo.jso:L26', 'demo.jso:L27', 'Bash', 'exit-1'],
  ]);
  assert.ok(calls.filter((c) => c.ok).every((c) => !('ek' in c)), 'a call that succeeded carries no error class');
  // the same bytes read twice hash the same: notes.txt at lines 12 and 16
  const reads = calls.filter((c) => c.r === 'demo.jso:L12' || c.r === 'demo.jso:L16');
  assert.equal(reads.length, 2);
  assert.equal(reads[0].out, reads[1].out);
  assert.notEqual(reads[0].in, reads[1].in);
});

test('addresses are physical line numbers: a blank line and a damaged line do not shift them', () => {
  const lines = readFileSync(BRANCHED, 'utf8').split('\n');
  for (const o of parsed(run('skeleton', BRANCHED).out)) {
    for (const address of [o.a, o.r].filter(Boolean)) {
      const n = Number(address.split(':L')[1]);
      const rec = JSON.parse(lines[n - 1]);
      assert.ok(rec.uuid.endsWith(String(n).padStart(12, '0')), `${address} names line ${n}, which holds ${rec.uuid}`);
    }
  }
  assert.deepEqual(parsed(run('skeleton', BRANCHED).out).map((o) => o.a), ['branched:L1', 'branched:L2', 'branched:L13', 'branched:L14']);
});

test('the live path follows the last-prompt pointer, not the deepest branch', () => {
  const out = run('skeleton', BRANCHED).out;
  // the rewound branch (lines 5 to 10) is deeper, and none of it is on the live path
  for (const line of [5, 6, 7, 8, 9, 10]) assert.ok(!out.includes(`branched:L${line}"`), `line ${line} is on the output`);
  assert.deepEqual(parsed(out).filter((o) => o.k === 'turn').map((o) => o.a), ['branched:L1', 'branched:L13']);
});

test('a late-written API error does not hide the retried turn: its calls stay on the live path', () => {
  const calls = parsed(run('skeleton', RETRIED).out).filter((o) => o.k === 'call');
  assert.deepEqual(calls.map((c) => `${c.a} -> ${c.r}`), ['retried.:L2 -> retried.:L3', 'retried.:L4 -> retried.:L5']);
});

test('a tool input of null is labelled, not fatal, and hashes as {}', () => {
  const r = run('skeleton', EDGES);
  assert.equal(r.code, 0);
  assert.equal(r.err, '');
  const read = parsed(r.out).find((o) => o.a === 'edges.js:L2');
  assert.equal(read.verb, '(none)');
  assert.equal(read.in, h12('{}'));
});

test('chains are counted within a turn: a failure is not closed by a success in the next turn', () => {
  // edges.jsonl: make fails at the end of turn 1 and passes in turn 2; that is not a 2-hop chain
  const st = JSON.parse(run('stats', EDGES).out);
  assert.equal(st.maxHops, 0);
  assert.equal(st.hopsOver2, 0);
  // and the same make command, sent twice, hashes the same
  const makes = parsed(run('skeleton', EDGES).out).filter((o) => o.verb === 'make');
  assert.equal(makes.length, 2);
  assert.equal(makes[0].in, makes[1].in);
});

test('no payload text from the fixtures appears in the output', () => {
  // labels: record and block vocabulary, ids, tool names, and the two input fields the output
  // uses as a verb on purpose (subagent_type, skill)
  const labels = new Set(['type', 'id', 'tool_use_id', 'name', 'subagent_type', 'skill']);
  for (const c of CASES) {
    const payload = new Set();
    const walk = (v, key) => {
      if (typeof v === 'string') { if (v.trim() !== '' && !labels.has(key)) payload.add(v); return; }
      if (Array.isArray(v)) { for (const x of v) walk(x, key); return; }
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    for (const { rec } of recordsOf(c.file)) {
      walk(rec.message?.content, 'content');
      walk(rec.toolUseResult, 'toolUseResult');
      walk(rec.lastPrompt, 'lastPrompt');
      walk(rec.cwd, 'cwd');
      walk(rec.sessionId, 'sessionId');
    }
    const strings = [...payload];
    assert.ok(strings.length >= c.minPayload, `${c.sid}: only ${strings.length} payload strings were collected`);
    // every payload string is long enough that finding it in the output cannot be a coincidence
    assert.deepEqual(strings.filter((s) => s.length < 8), [], c.sid);
    const output = run('skeleton', c.file).out + run('stats', c.file).out;
    assert.deepEqual(strings.filter((s) => output.includes(s)), [], c.sid);
  }
  const output = run('skeleton', DEMO, VARIETY, BRANCHED, RETRIED, EDGES, AGENT).out;
  for (const s of ['limerick', 'poem', 'npm test', 'rm -rf', 'recieve', '/work/', 'demo-gate.sh', 'PreToolUse', 'String to replace', 'FOO=1', 'two words', 'sudo make']) {
    assert.ok(!output.includes(s), `the output contains '${s}'`);
  }
});

// ---- stats ----------------------------------------------------------------------------------

test('stats: known answers', () => {
  const r = run('stats', DEMO, VARIETY, BRANCHED, RETRIED, EDGES, AGENT);
  assert.equal(r.code, 0);
  assert.match(r.err, /^memobrain stats: warning: '[^']*branched\.jsonl': 1 line could not be read/);
  assert.equal(nonEmpty(r.err).length, 1);
  assert.equal(r.out, [
    { session: 'demo.jso', turns: 4, prompts: 3, calls: 12, failures: 5,
      errorClasses: { other: 1, 'no-anchor': 1, 'hook-block:demo-gate': 1, 'exit-1': 2 },
      retries: 2, detours: 2, maxHops: 3, hopsOver2: 1 },
    { session: 'variety.', turns: 2, prompts: 2, calls: 13, failures: 5,
      errorClasses: { 'not-read': 1, 'bad-input': 1, denied: 1, other: 1, 'hook-block': 1 },
      retries: 3, detours: 2, maxHops: 0, hopsOver2: 0 },
    { session: 'branched', turns: 2, prompts: 2, calls: 2, failures: 0, errorClasses: {},
      retries: 0, detours: 0, maxHops: 0, hopsOver2: 0 },
    { session: 'retried.', turns: 1, prompts: 1, calls: 2, failures: 0, errorClasses: {},
      retries: 0, detours: 0, maxHops: 0, hopsOver2: 0 },
    { session: 'edges.js', turns: 2, prompts: 2, calls: 3, failures: 2, errorClasses: { 'bad-input': 1, 'exit-2': 1 },
      retries: 0, detours: 1, maxHops: 0, hopsOver2: 0 },
    { session: 'agent.js', turns: 1, prompts: 0, calls: 1, failures: 0, errorClasses: {},
      retries: 0, detours: 0, maxHops: 0, hopsOver2: 0 },
  ].map((o) => JSON.stringify(o) + '\n').join(''));
});

for (const c of CASES) {
  test(`stats ${c.sid} agrees with skeleton`, () => {
    const sk = parsed(run('skeleton', c.file).out);
    const st = JSON.parse(run('stats', c.file).out);
    const turns = [];
    for (const o of sk) { if (o.k === 'turn') turns.push({ ch: o.ch, calls: [] }); else turns[turns.length - 1].calls.push(o); }
    const n = { turns: turns.length, prompts: turns.filter((t) => ['typed', 'sdk', 'input'].includes(t.ch)).length, calls: 0, failures: 0, errorClasses: {}, retries: 0, detours: 0, maxHops: 0, hopsOver2: 0 };
    for (const t of turns) {
      t.calls.forEach((call, i) => {
        n.calls++;
        if (!call.ok) { n.failures++; n.errorClasses[call.ek] = (n.errorClasses[call.ek] ?? 0) + 1; }
        const before = t.calls[i - 1];
        if (before && !before.ok) { if (call.tool === before.tool) n.retries++; else n.detours++; }
      });
      // a chain: failures with one verb in a row (a failure with another verb starts a new one),
      // closed by a later success with that verb; its hops are the failures plus that success
      let verb = null, failures = 0;
      for (const call of t.calls) {
        if (!call.ok) { if (call.verb === verb) failures++; else { verb = call.verb; failures = 1; } }
        else if (failures && call.verb === verb) { n.maxHops = Math.max(n.maxHops, failures + 1); if (failures + 1 > 2) n.hopsOver2++; verb = null; failures = 0; }
      }
    }
    const { session, ...counts } = st;
    assert.equal(session, c.sid);
    assert.deepEqual(counts, n);
  });
}

test('stats: one line per file, in argument order', () => {
  const r = run('stats', DEMO, fixture('empty.jsonl'), VARIETY, DEMO);
  assert.equal(r.code, 0);
  assert.deepEqual(parsed(r.out).map((o) => o.session), ['demo.jso', 'empty.js', 'variety.', 'demo.jso']);
});

// ---- files with nothing to show -------------------------------------------------------------

test('a file that is not a transcript: zero counts and warnings that say why', () => {
  const file = fixture('not-a-transcript.jsonl');
  const r = run('stats', file);
  assert.equal(r.code, 0);
  assert.equal(r.out, JSON.stringify({ session: 'not-a-tr', turns: 0, prompts: 0, calls: 0, failures: 0, errorClasses: {}, retries: 0, detours: 0, maxHops: 0, hopsOver2: 0 }) + '\n');
  assert.match(r.err, new RegExp(`'${escapeRe(file)}': 1 line could not be read as a JSON object \\(first: line 3\\) and was skipped`));
  assert.match(r.err, new RegExp(`'${escapeRe(file)}' has no conversation records .*record types found: \\(none\\), note\\), so its counts are 0`));
  assert.match(r.err, /~\/\.claude\/projects\//);
});

test('a workflow journal and an empty file: warnings, not silent zeros', () => {
  let r = run('skeleton', fixture('journal.jsonl'));
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  assert.match(r.err, /journal\.jsonl' is a workflow journal .* so it adds no lines/);
  r = run('stats', fixture('empty.jsonl'));
  assert.equal(r.code, 0);
  assert.match(r.err, /empty\.jsonl' holds no records, so its counts are 0/);
  r = run('stats', fixture('no-turns.jsonl'));
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).turns, 0);
  assert.match(r.err, /no-turns\.jsonl' has conversation records but no turn on its live path, so its counts are 0/);
});

// ---- errors ---------------------------------------------------------------------------------

test('a file that cannot be read: exit 1, the file named, the other files still processed', () => {
  const missing = fixture('no-such-file.jsonl');
  const r = run('stats', missing, DEMO);
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`memobrain stats: cannot read '${escapeRe(missing)}': no such file or directory`));
  assert.match(r.err, /~\/\.claude\/projects\/<project>\/<session>\.jsonl/);
  assert.match(r.err, /1 of 2 files done; 1 failed/);
  assert.deepEqual(parsed(r.out).map((o) => o.session), ['demo.jso']);
});

test('a directory is named as one, with the command to run instead', () => {
  const dir = join(here, 'fixtures');
  const r = run('skeleton', dir);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, new RegExp(`'${escapeRe(dir)}' is a directory.*memobrain skeleton ${escapeRe(dir)}/\\*\\.jsonl`));
});

test('usage errors: exit 2, nothing on stdout, the message names the input and the fix', () => {
  const cases = [
    { args: [], message: /^memobrain: no command given\.\n\nUsage:\n {2}memobrain skeleton <file\.jsonl>/ },
    { args: ['skelton', DEMO], message: /unknown command 'skelton'\. The commands are skeleton and stats/ },
    { args: ['--frobnicate'], message: /unknown option '--frobnicate'\. The options are --help and --version/ },
    { args: ['stats'], message: /memobrain stats: no input files\. Pass one or more transcripts, e\.g\. memobrain stats ~\/\.claude/ },
    { args: ['stats', '--summary', DEMO], message: /memobrain stats: unknown option '--summary'.*put -- before a file name/ },
    { args: ['skeleton', '-'], message: /reading from standard input \('-'\) is not supported/ },
  ];
  for (const { args, message } of cases) {
    const r = run(...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.out, '', args.join(' '));
    assert.match(r.err, message, args.join(' '));
  }
});

test('-- ends the options', () => {
  const r = run('stats', '--', DEMO);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).calls, 12);
});

// ---- help, version, package -----------------------------------------------------------------

test('--version prints the version in package.json', () => {
  const pkg = JSON.parse(readFileSync(join(dirname(CLI), '..', 'package.json'), 'utf8'));
  for (const flag of ['--version', '-v']) {
    const r = run(flag);
    assert.equal(r.code, 0);
    assert.equal(r.out, `${pkg.version}\n`);
  }
});

test('--help describes every field the two commands print', () => {
  const keys = new Set();
  for (const o of parsed(run('skeleton', DEMO, VARIETY).out)) for (const k of Object.keys(o)) keys.add(k);
  for (const k of Object.keys(JSON.parse(run('stats', DEMO).out))) keys.add(k);
  assert.ok(keys.size >= 20);
  for (const flag of ['--help', '-h', 'help']) {
    const r = run(flag);
    assert.equal(r.code, 0);
    for (const k of keys) assert.match(r.out, new RegExp(`^ {2}${k} +\\S`, 'm'), `${flag} does not describe '${k}'`);
  }
  assert.equal(run('stats', '--help').out, run('--help').out);
});

test('README: its example lines are what the commands print, and it describes every field', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const examples = readme.split('\n').filter((l) => l.startsWith('{"k":') || l.startsWith('{"session":'));
  assert.ok(examples.length >= 7, `only ${examples.length} example lines found`);
  const printed = new Set(nonEmpty(run('skeleton', DEMO).out + run('stats', DEMO).out));
  for (const l of examples) assert.ok(printed.has(l), `the README shows a line the commands do not print: ${l}`);
  const keys = new Set();
  for (const o of parsed(run('skeleton', DEMO, VARIETY).out)) for (const k of Object.keys(o)) keys.add(k);
  for (const k of Object.keys(JSON.parse(run('stats', DEMO).out))) keys.add(k);
  for (const k of keys) assert.match(readme, new RegExp(`^\\| \`${k}\` \\|`, 'm'), `the README does not describe '${k}'`);
});

test('the package: a shebang, no runtime dependencies, nothing imported but node: built-ins', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.bin.memobrain, 'dist/cli.js');
  assert.ok(readFileSync(CLI, 'utf8').startsWith('#!/usr/bin/env node\n'));
  for (const f of ['cli.js', 'parser.js']) {
    const src = readFileSync(join(dirname(CLI), f), 'utf8');
    const specifiers = [...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const s of specifiers) assert.ok(s.startsWith('node:') || s === './parser.js', `${f} imports '${s}'`);
    assert.doesNotMatch(src, /\brequire\s*\(|\bimport\s*\(|\bfetch\s*\(|node:(?:https?|net|dgram|tls|http2|child_process)\b/, f);
  }
});
