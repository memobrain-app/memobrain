// Writes the generated test fixtures: labels.jsonl, unanswered.jsonl, cycle.jsonl, rare-shapes.jsonl and
// journal-launched.jsonl. Every string in them is invented; the record format follows the hand-written
// fixtures (edges.jsonl). The output is the same on every run.
//
//   node test/make-fixtures.mjs test/fixtures
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const DIR = process.argv[2];
if (!DIR) { console.error('usage: node test/make-fixtures.mjs <directory to write the fixtures in, e.g. test/fixtures>'); process.exit(2); }
const env = (sid) => ({ isSidechain: false, userType: 'external', cwd: '/work/demo-project', version: '2.0.0', gitBranch: 'main', entrypoint: 'cli', sessionId: sid });
function file(name, sid, pre) {
  const lines = []; let n = 0, last = null, sec = 0;
  const uuid = (k) => `${pre}-0000-4000-8000-${String(k).padStart(12, '0')}`;
  const ts = () => { sec += 2; return new Date(Date.UTC(2026, 7, 1, 10, 0, sec)).toISOString(); };
  const api = {
    raw(obj) { lines.push(JSON.stringify(obj)); },
    prompt(text, extra = {}, parent = last) { const u = uuid(++n); lines.push(JSON.stringify({ parentUuid: parent, ...env(sid), type: 'user', message: { role: 'user', content: text }, uuid: u, timestamp: ts(), promptId: `${pre}-1111-4000-8000-${String(n).padStart(12, '0')}`, ...extra })); last = u; return u; },
    use(id, name, input, parent = last) { const u = uuid(++n); lines.push(JSON.stringify({ parentUuid: parent, ...env(sid), type: 'assistant', message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'claude-demo-model', content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } }, requestId: `req_${id}`, uuid: u, timestamp: ts() })); last = u; return u; },
    result(id, content, { isError = false, tur, blocks, parent = last } = {}) {
      const u = uuid(++n);
      const block = { tool_use_id: id, type: 'tool_result', content, is_error: isError };
      const rec = { parentUuid: parent, ...env(sid), type: 'user', message: { role: 'user', content: blocks ? blocks(block) : [block] }, uuid: u, timestamp: ts(),
        toolUseResult: tur ?? (isError ? `Error: ${typeof content === 'string' ? content : 'demo failure text'}` : { stdout: 'demo standard output', stderr: '', interrupted: false, isImage: false }),
        sourceToolAssistantUUID: parent };
      lines.push(JSON.stringify(rec)); last = u; return u;
    },
    text(t, parent = last) { const u = uuid(++n); lines.push(JSON.stringify({ parentUuid: parent, ...env(sid), type: 'assistant', message: { id: `msg_${pre}_${n}`, type: 'message', role: 'assistant', model: 'claude-demo-model', content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }, requestId: `req_${pre}_${n}`, uuid: u, timestamp: ts() })); last = u; return u; },
    replay(lineNo, newParent) { const o = JSON.parse(lines[lineNo - 1]); if (newParent !== undefined) o.parentUuid = newParent; lines.push(JSON.stringify(o)); },
    leaf(text, u = last) { lines.push(JSON.stringify({ type: 'last-prompt', lastPrompt: text, leafUuid: u, sessionId: sid })); },
    uuid, get last() { return last; }, set last(v) { last = v; },
    write() { writeFileSync(join(DIR, name), lines.join('\n') + '\n'); },
  };
  return api;
}

// labels.jsonl: one rule of the label check per call, then two prompts whose channel is the record's own word.
{
  const f = file('labels.jsonl', '12121212-3434-4565-8787-909090909090', 'd1000000');
  const p1 = 'Exercise every labelling rule in the demo project.';
  f.prompt(p1, { promptSource: 'typed' });
  const calls = [
    ['toolu_labels_01', 'Skill', { skill: { note: 'INVENTED PAYLOAD TEXT inside the skill field' } }],
    ['toolu_labels_02', 'Agent', { subagent_type: 'a long invented sentence standing in for free text typed into the field', description: 'invented review task', prompt: 'Review the invented demo changes.' }],
    ['toolu_labels_03', 'Read', { file_path: 'C:\\Users\\invented.person\\projects\\Makefile' }],
    ['toolu_labels_04', 'Read', { file_path: 'C:\\Users\\invented.person\\notes\\plan.txt' }],
    ['toolu_labels_05', 'Bash', { command: 'C:\\Users\\invented.person\\bin\\tool.exe --x' }],
    ['toolu_labels_06', 'Bash', { command: 'T=$(cat /work/demo-project/secret-token.txt)' }],
    ['toolu_labels_07', 'Bash', { command: 'TS=$(date +%s.%N)\nnpm test' }],
    ['toolu_labels_08', 'Bash', { command: '{ make demo; } 2>&1' }],
    ['toolu_labels_09', 'Bash', { command: 'nice -n 10 make demo' }],
    ['toolu_labels_10', 'Bash', { command: 'cd /work/demo-project\nnpm test' }],
    ['toolu_labels_11', 'Bash', { command: '"$PY" scripts/demo.py' }],
    ['toolu_labels_12', 'Bash', { command: '[[ -f demo.txt ]] && make demo' }],
    ['toolu_labels_13', 'Bash', { command: '# a comment line\nls -la' }],
    ['toolu_labels_14', 'Bash', { command: 'timeout -s KILL 10 make demo' }],
    ['toolu_labels_15', 'Bash', { command: 'env -i PATH=/usr/bin make demo' }],
    ['toolu_labels_16', 'Bash', { command: '(cd /work/demo-project && make demo)' }],
    ['toolu_labels_17', 'Bash', { command: '! grep -q demo notes.txt' }],
    ['toolu_labels_18', 'Bash', { command: '2>/dev/null ls' }],
    ['toolu_labels_19', 'Bash', { command: 'REV="$(git rev-parse HEAD)"' }],
    ['toolu_labels_20', 'do something invented', { what: 'an invented tool that no harness defines' }],
    ['toolu_labels_21', 'Bash', { command: 'cd /work/demo-project && FILES=$(ls *.txt) && wc -l $FILES' }],
    ['toolu_labels_22', 'Bash', { command: 'A=1 B=\'two words\' C="$(echo nested $(pwd))" make demo' }],
    ['toolu_labels_23', 'Bash', { command: './node_modules/.bin/a-very-long-program-name-that-goes-past-the-sixty-four-character-label-limit --x' }],
    ['toolu_labels_24', 'Bash', { command: 'sudo -u demo make install' }],
    ['toolu_labels_25', 'Bash', { command: 'cd /work/demo-project 2>/dev/null && make demo' }],
    ['toolu_labels_26', 'Bash', { command: 'F=(); for f in *.txt; do F+=("$f"); done' }],
    ['toolu_labels_27', 'Bash', { command: '$DEMO_DIR/scripts/demo-run.sh --fast' }],
    ['toolu_labels_28', 'Bash', { command: 'MARK="demo-$(head -c6 /dev/urandom | od -An -tx1)"\nsystemctl --user status demo.service' }],
  ];
  calls.forEach(([id, name, input], i) => { f.use(id, name, input); f.result(id, `invented output number ${String(i + 1).padStart(2, '0')}`); });
  f.text('Every rule was exercised on the demo project.');
  f.prompt('A message relayed from another invented agent.', { origin: { kind: 'peer' } });
  f.text('The peer message was read.');
  f.prompt('A message whose origin field holds free text.', { origin: { kind: 'free text with spaces in the origin kind' } });
  f.text('That message was read too.');
  f.leaf('A message whose origin field holds free text.');
  f.write();
}

// unanswered.jsonl: a failed make, a make whose result was never written, a passing make; then a call
// at the end of the file, cut before it returned.
{
  const f = file('unanswered.jsonl', '23232323-4545-4676-8898-a0a0a0a0a0a0', 'd3000000');
  f.prompt('Run the demo tests until they pass.', { promptSource: 'typed' });
  f.use('toolu_unanswered_01', 'Bash', { command: 'make test' });
  f.result('toolu_unanswered_01', 'Exit code 2\nmake: *** [test] Error 2', { isError: true });
  f.use('toolu_unanswered_02', 'Bash', { command: 'make test' });
  f.use('toolu_unanswered_03', 'Bash', { command: 'make test' });
  f.result('toolu_unanswered_03', 'all demo tests passed at last');
  f.text('The tests pass now.');
  f.prompt('Now build the demo release.', { promptSource: 'typed' });
  f.use('toolu_unanswered_04', 'Bash', { command: 'make release' });
  f.leaf('Now build the demo release.');
  f.write();
}

// cycle.jsonl: a prompt whose parentUuid names itself, a call below it, and two records that name each other.
{
  const f = file('cycle.jsonl', '34343434-5656-4787-89a9-b0b0b0b0b0b0', 'd5000000');
  const u1 = f.uuid(1);
  f.prompt('Run the demo tests once.', { promptSource: 'typed' }, u1);
  f.use('toolu_cycle_01', 'Bash', { command: 'make test' });
  f.result('toolu_cycle_01', 'all demo tests passed');
  const a = f.uuid(4), b = f.uuid(5);
  f.text('An invented record whose parent is the next one.', b);
  f.text('An invented record whose parent is the previous one.', a);
  f.write();
}

// rare-shapes.jsonl: result content holding a bare string; a hook block that only the PreToolUse: prefix
// identifies; a tool result recognised only by toolUseResult (its first block is text); and the first
// call and its result written again at the end, the call re-parented, as replays are.
{
  const f = file('rare-shapes.jsonl', '45454545-6767-4898-8aba-c0c0c0c0c0c0', 'd7000000');
  f.prompt('Show the rare record shapes of the demo project.', { promptSource: 'typed' });
  f.use('toolu_rare_01', 'Bash', { command: 'make demo-report' });
  f.result('toolu_rare_01', ['the first part, as a bare string', { type: 'text', text: 'the second part, as a text block' }]);
  f.use('toolu_rare_02', 'Read', { file_path: '/work/elsewhere/invented-outside-file.txt' });
  f.result('toolu_rare_02', 'PreToolUse:Read hook error: [node /work/demo-project/.claude/hooks/demo-guard.mjs]: refused: reads outside the demo project', { isError: true });
  f.use('toolu_rare_03', 'Bash', { command: 'make demo-lint' });
  f.result('toolu_rare_03', 'demo lint found nothing to report', { blocks: (b) => [{ type: 'text', text: 'an invented note written before the result block' }, b] });
  const end = f.text('The rare shapes were shown.');
  f.replay(2, end);
  f.replay(3);
  f.leaf('Show the rare record shapes of the demo project.', end);
  f.write();
}

// journal-launched.jsonl: a workflow journal as newer harness versions write it, opening with "launched".
writeFileSync(join(DIR, 'journal-launched.jsonl'), [
  { type: 'launched' },
  { type: 'started', key: 'v2:0000000000000000000000000000000000000000000000000000000000000002', agentId: 'demo-agent-2', label: 'invented label', phase: 'invented phase' },
  { type: 'result', key: 'v2:0000000000000000000000000000000000000000000000000000000000000002', agentId: 'demo-agent-2', result: 'invented result text' },
].map((o) => JSON.stringify(o)).join('\n') + '\n');

// ---- the second set: what the pre-publish review found (every string invented; ZQX markers must never print) ----

// lexer.jsonl: one Bash call per shape the verb lexer must read, or must withhold (fail closed)
const LEXER_CASES = [
  // [command, expected verb]
  ["MSG=$(cat <<'EOF'\nTwo invented fixes:\n1) ZQXA01 parser guard\nEOF\n)\ngit commit -m \"$MSG\"", '(withheld)'],
  ['exec 3<<EOF\nZQXA02 invented secret\nEOF\ncat <&3', '(withheld)'],
  ['cd /work/demo-project <<EOF\nZQXA03 body word\nEOF', '(withheld)'],
  ['<<EOF\nZQXA04 body\nEOF', '(withheld)'],
  ["X=$'a\\' ZQXA05 b'", '(empty)'],
  ['NAME="${NAME:-"Invented ZQXA06 Person"}" ./run.sh', 'run.sh'],
  ["X=$(echo a # a comment with ) and 'ZQXA07\n)\nmake demo", 'make'],
  ['X=$(case $y in a) echo ZQXA08;; esac)', '(withheld)'],
  ['((ZQXA09++))', '(withheld)'],
  ['X=$[ZQXA10+1]', '(empty)'],
  ["X='$(ZQXA11 invented)'", '(empty)'],
  ['X="it\'s $(date +%s)"', 'date'],
  ['command time -o payroll-ZQXA12.txt make demo', 'make'],
  ['env -P /opt/ZQXA13/bin make demo', 'make'],
  ["env -S 'ZQXA14 make'", '(withheld)'],
  ['time --format=ZQXA15 make demo', 'make'],
  ['nice -n10 make demo', 'make'],
  ['timeout --signal=KILL 5 make demo', 'make'],
  ['exec -a ZQXA16 make demo', 'make'],
  ['timeout --kill-sig=9 5 ZQXA17', '(withheld)'],
  ['X=$(make', '(withheld)'],
  ['echo "ZQXA18 never closed', 'echo'],
  ['ZQXA19name() { make demo; }', '(withheld)'],
  ['function ZQXA20 { make demo; }', '(withheld)'],
  ['env | grep zqx', 'env'],
  ['cd /work/demo-project &>/dev/null && make demo', 'make'],
  ["IFS=$'\\n' read -r line", 'read'],
  [Array.from({ length: 70 }, (_, i) => `V${i}=1`).join(' ') + ' make demo', '(withheld)'],
  ['X=$(cat ZQXA21.txt) && wc -l "$X"', 'wc'],
  [': > /work/demo-project/out.txt', ':'],
  ['g++ demo.cpp -o demo', 'g++'],
  ['./' + 'a'.repeat(64) + ' --x', 'a'.repeat(64)],
  ['./' + 'b'.repeat(65) + ' --x', '(withheld)'],
  ['X="$(printf %s "ZQXA22") done"', 'printf'],
];
{
  const f = file('lexer.jsonl', '56565656-7878-4909-8bcb-d0d0d0d0d0d0', 'd9000000');
  f.prompt('Run each invented shell shape once.', { promptSource: 'typed' });
  LEXER_CASES.forEach(([command], i) => {
    const id = `toolu_lexer_${String(i + 1).padStart(2, '0')}`;
    f.use(id, 'Bash', { command });
    f.result(id, `invented lexer output ${String(i + 1).padStart(2, '0')}`);
  });
  f.text('Every shape was run.');
  f.leaf('Run each invented shell shape once.');
  f.write();
}
writeFileSync(join(DIR, 'lexer.expected.json'), JSON.stringify(LEXER_CASES.map(([, v]) => v)) + '\n');

// labels2.jsonl: labels that are not strings, at the length limit, and file names with a ':' in them
const LABEL2_CASES = [
  ['Agent', { subagent_type: ['zqx-array-ZQXB01'], description: 'invented task one', prompt: 'Invented prompt one.' }, '(withheld)'],
  ['Agent', { subagent_type: 42, description: 'invented task two', prompt: 'Invented prompt two.' }, '(withheld)'],
  ['Skill', { skill: ['ZQXB02-skill'] }, '(withheld)'],
  ['Agent', { subagent_type: 'team/ZQXB03', description: 'invented task three', prompt: 'Invented prompt three.' }, '(withheld)'],
  ['mcp__demo_server__demo_tool', { query: 'an invented query ZQXB04' }, 'mcp__demo_server__demo_tool'],
  ['Read', { file_path: 'invented-host:ZQXB05' }, '(withheld)'],
  ['Read', { file_path: '/work/demo-project/notes.txt:ZQXB06' }, '(withheld)'],
  ['Read', { file_path: { toString: 'ZQXB07 not callable' } }, '(withheld)'],
  ['Bash', { command: { ZQXB08: 'an object, not a command' } }, '(withheld)'],
];
{
  const f = file('labels2.jsonl', '67676767-8989-4a1a-8cdc-e0e0e0e0e0e0', 'da000000');
  f.prompt('Exercise the remaining label rules.', { promptSource: 'typed' });
  LABEL2_CASES.forEach(([name, input], i) => {
    const id = `toolu_labels2_${String(i + 1).padStart(2, '0')}`;
    f.use(id, name, input);
    f.result(id, `invented label output ${String(i + 1).padStart(2, '0')}`);
  });
  f.text('The remaining rules were exercised.');
  f.leaf('Exercise the remaining label rules.');
  f.write();
}
writeFileSync(join(DIR, 'labels2.expected.json'), JSON.stringify(LABEL2_CASES.map(([n, , v]) => [n, v])) + '\n');

// errors.jsonl: error classes come from the harness's own formats only, never from words of a tool's output
{
  const f = file('errors.jsonl', '78787878-9a9a-4b2b-8ded-f0f0f0f0f0f0', 'db000000');
  f.prompt('Run the invented failing tools.', { promptSource: 'typed' });
  const cases = [
    ['toolu_errors_01', 'WebFetch', { url: 'https://example.invalid/ZQXC01' }, 'Request blocked by the corporate hook [ZQXC02_client.js] see the invented log'],
    ['toolu_errors_02', 'Read', { file_path: '/work/demo-project/a.txt' }, 'Error: an invented failure\nthe log said Exit code 4111111111111111 at the end'],
    ['toolu_errors_03', 'Bash', { command: 'make demo' }, 'PreToolUse:Bash hook error: [bash /work/demo-project/.claude/hooks/' + 'h'.repeat(60) + '.sh]: an invented refusal'],
    ['toolu_errors_04', 'Bash', { command: 'make demo' }, 'Exit code 1\nmake: an invented error'],
    ['toolu_errors_05', 'Bash', { command: 'make demo' }, 'Exit code 4096\nan invented error with a long code'],
    ['toolu_errors_06', 'Bash', { command: 'make demo' }, 'PreToolUse:Bash hook error: [node /work/demo-project/.claude/hooks/demo-guard.mjs]: an invented refusal'],
  ];
  for (const [id, name, input, text] of cases) { f.use(id, name, input); f.result(id, text, { isError: true }); }
  f.text('The failures were seen.');
  f.leaf('Run the invented failing tools.');
  f.write();
}

// parallel.jsonl: two calls of ONE API response; the second call's result is written first, and the session goes
// on from the first call's result. Both calls belong to the turn.
{
  const sid = '89898989-abab-4c3c-8efe-a1a1a1a1a1a1', pre = 'dc000000';
  const f = file('parallel.jsonl', sid, pre);
  const p = f.prompt('Read two invented files at once.', { promptSource: 'typed' });
  const a1 = f.uuid(2), a2 = f.uuid(3), r2 = f.uuid(4), r1 = f.uuid(5), t = f.uuid(6);
  const env = { isSidechain: false, userType: 'external', cwd: '/work/demo-project', version: '2.0.0', gitBranch: 'main', entrypoint: 'cli', sessionId: sid };
  const msg = (id, block) => ({ id: 'msg_parallel_01', type: 'message', role: 'assistant', model: 'claude-demo-model', content: [block], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20 } });
  f.raw({ parentUuid: p, ...env, type: 'assistant', message: msg('a', { type: 'tool_use', id: 'toolu_parallel_01', name: 'Read', input: { file_path: '/work/demo-project/one.txt' } }), requestId: 'req_parallel_01', uuid: a1, timestamp: '2026-08-01T11:00:02.000Z' });
  f.raw({ parentUuid: a1, ...env, type: 'assistant', message: msg('b', { type: 'tool_use', id: 'toolu_parallel_02', name: 'Read', input: { file_path: '/work/demo-project/two.txt' } }), requestId: 'req_parallel_01', uuid: a2, timestamp: '2026-08-01T11:00:02.100Z' });
  f.raw({ parentUuid: a2, ...env, type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_parallel_02', type: 'tool_result', content: 'the invented second file' }] }, uuid: r2, timestamp: '2026-08-01T11:00:03.000Z', toolUseResult: { type: 'text' }, sourceToolAssistantUUID: a2 });
  f.raw({ parentUuid: a1, ...env, type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_parallel_01', type: 'tool_result', content: 'the invented first file' }] }, uuid: r1, timestamp: '2026-08-01T11:00:04.000Z', toolUseResult: { type: 'text' }, sourceToolAssistantUUID: a1 });
  f.raw({ parentUuid: r1, ...env, type: 'assistant', message: { id: 'msg_parallel_02', type: 'message', role: 'assistant', model: 'claude-demo-model', content: [{ type: 'text', text: 'Both invented files were read.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }, requestId: 'req_parallel_02', uuid: t, timestamp: '2026-08-01T11:00:05.000Z' });
  f.leaf('Read two invented files at once.', t);
  f.write();
}

// compacted.jsonl / compacted-nopointer.jsonl: a full compaction (the boundary is a new root whose
// logicalParentUuid names the last record before it). The segment before it is the longer one. Without a
// last-prompt pointer the path still ends at the last record written, and the join still brings the first segment.
for (const [name, pointer] of [['compacted.jsonl', true], ['compacted-nopointer.jsonl', false]]) {
  const sid = pointer ? '9a9a9a9a-bcbc-4d4d-8f0f-b2b2b2b2b2b2' : 'abababab-cdcd-4e5e-8a1a-c3c3c3c3c3c3';
  const f = file(name, sid, pointer ? 'dd000000' : 'de000000');
  f.prompt('Build the invented demo, part one.', { promptSource: 'typed' });
  for (let i = 1; i <= 3; i++) { f.use(`toolu_${pointer ? 'cp' : 'cn'}_0${i}`, 'Bash', { command: `make part-${i}` }); f.result(`toolu_${pointer ? 'cp' : 'cn'}_0${i}`, `invented part ${i} built`); }
  const before = f.text('Part one is built.');
  const boundary = f.uuid(20), summary = f.uuid(21);
  const env = { isSidechain: false, userType: 'external', cwd: '/work/demo-project', version: '2.0.0', gitBranch: 'main', entrypoint: 'cli', sessionId: sid };
  f.raw({ parentUuid: null, logicalParentUuid: before, ...env, type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'manual', preTokens: 12000 }, uuid: boundary, timestamp: '2026-08-01T12:00:00.000Z' });
  f.raw({ parentUuid: boundary, ...env, type: 'user', isCompactSummary: true, message: { role: 'user', content: 'An invented summary of part one.' }, uuid: summary, timestamp: '2026-08-01T12:00:01.000Z' });
  f.last = summary;
  f.prompt('Build the invented demo, part two.', { promptSource: 'typed' });
  f.use(`toolu_${pointer ? 'cp' : 'cn'}_04`, 'Bash', { command: 'make part-4' });
  f.result(`toolu_${pointer ? 'cp' : 'cn'}_04`, 'invented part 4 built');
  const end = f.text('Part two is built.');
  if (pointer) f.leaf('Build the invented demo, part two.', end);
  f.write();
}

// stale-head.jsonl: the last-prompt pointer was written before the final exchange, which sits below it
{
  const f = file('stale-head.jsonl', 'bcbcbcbc-dede-4f6f-8b2b-d4d4d4d4d4d4', 'df000000');
  const p = f.prompt('Run the two invented checks.', { promptSource: 'typed' });
  f.leaf('Run the two invented checks.', p);
  f.use('toolu_stale_01', 'Bash', { command: 'make check-one' }); f.result('toolu_stale_01', 'invented check one passed');
  f.use('toolu_stale_02', 'Bash', { command: 'make check-two' }); f.result('toolu_stale_02', 'invented check two passed');
  f.text('Both invented checks passed.');
  f.write();
}

// retried3.jsonl: a request failed; the retried branch made three calls; the api_error record was written after
// all of them but parented before them, and the turn's last record hangs off the error
{
  const sid = 'cdcdcdcd-efef-4a7a-8c3c-e5e5e5e5e5e5';
  const f = file('retried3.jsonl', sid, 'e0000000');
  f.prompt('Run the invented suite with retries.', { promptSource: 'typed' });
  f.use('toolu_retry3_01', 'Bash', { command: 'make prepare' });
  const tip = f.result('toolu_retry3_01', 'invented preparation done');
  for (let i = 2; i <= 4; i++) { f.use(`toolu_retry3_0${i}`, 'Bash', { command: `make step-${i}` }); f.result(`toolu_retry3_0${i}`, `invented step ${i} done`); }
  const env = { isSidechain: false, userType: 'external', cwd: '/work/demo-project', version: '2.0.0', gitBranch: 'main', entrypoint: 'cli', sessionId: sid };
  const err = f.uuid(30);
  f.raw({ parentUuid: tip, ...env, type: 'system', subtype: 'api_error', level: 'error', content: 'invented connection reset', uuid: err, timestamp: '2026-08-01T10:00:05.000Z' });
  f.last = err;
  const end = f.text('The invented suite finished after a retry.');
  f.leaf('Run the invented suite with retries.', end);
  f.write();
}

// orphan-first.jsonl: the first record names a parent that is in no file
{
  const f = file('orphan-first.jsonl', 'dededede-0a0a-4b8b-8d4d-f6f6f6f6f6f6', 'e1000000');
  f.prompt('Continue the invented work.', { promptSource: 'typed' }, 'e1999999-0000-4000-8000-000000000999');
  f.use('toolu_orphan_01', 'Bash', { command: 'make continue' }); f.result('toolu_orphan_01', 'invented work continued');
  f.text('The invented work continued.');
  f.leaf('Continue the invented work.');
  f.write();
}

// cycle-stale.jsonl, cycle-logical.jsonl, cycle-head.jsonl: a parentUuid cycle reached through each guarded walk -
// the stale-head extension, a compaction join through the logical parent, and one through preservedSegment.headUuid
{
  const env = (sid) => ({ isSidechain: false, userType: 'external', cwd: '/work/demo-project', version: '2.0.0', gitBranch: 'main', entrypoint: 'cli', sessionId: sid });
  const rec = (sid, uuid, parent, type, content, extra = {}) => JSON.stringify({ parentUuid: parent, ...env(sid), type, message: type === 'user' ? { role: 'user', content } : { id: 'msg_' + uuid.slice(0, 8), type: 'message', role: 'assistant', model: 'claude-demo-model', content: [{ type: 'text', text: content }], stop_reason: 'end_turn' }, uuid, timestamp: '2026-08-01T13:00:00.000Z', ...(type === 'user' ? { promptSource: 'typed' } : { requestId: 'req_' + uuid.slice(0, 8) }), ...extra });
  const u = (pre, k) => `${pre}-0000-4000-8000-${String(k).padStart(12, '0')}`;
  let sid = 'e2e2e2e2-1111-4c9c-8e5e-a7a7a7a7a7a7', P = 'e2000000';
  writeFileSync(join(DIR, 'cycle-stale.jsonl'), [
    rec(sid, u(P, 1), null, 'user', 'An invented first prompt.'),
    rec(sid, u(P, 2), u(P, 1), 'assistant', 'An invented first reply.'),
    rec(sid, u(P, 3), u(P, 4), 'user', 'An invented prompt on a cycle.'),
    rec(sid, u(P, 4), u(P, 3), 'assistant', 'An invented reply on a cycle.'),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'An invented prompt on a cycle.', leafUuid: u(P, 3), sessionId: sid }),
  ].join('\n') + '\n');
  sid = 'e3e3e3e3-2222-4dad-8f6f-b8b8b8b8b8b8'; P = 'e3000000';
  writeFileSync(join(DIR, 'cycle-logical.jsonl'), [
    rec(sid, u(P, 1), u(P, 2), 'user', 'An invented prompt on a cycle.'),
    rec(sid, u(P, 2), u(P, 1), 'assistant', 'An invented reply on a cycle.'),
    JSON.stringify({ parentUuid: null, logicalParentUuid: u(P, 2), ...env(sid), type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', uuid: u(P, 3), timestamp: '2026-08-01T13:00:01.000Z' }),
    JSON.stringify({ parentUuid: u(P, 3), ...env(sid), type: 'user', isCompactSummary: true, message: { role: 'user', content: 'An invented summary.' }, uuid: u(P, 4), timestamp: '2026-08-01T13:00:02.000Z' }),
    rec(sid, u(P, 5), u(P, 4), 'user', 'An invented prompt after the compaction.'),
    rec(sid, u(P, 6), u(P, 5), 'assistant', 'An invented reply after the compaction.'),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'An invented prompt after the compaction.', leafUuid: u(P, 6), sessionId: sid }),
  ].join('\n') + '\n');
  sid = 'e4e4e4e4-3333-4ebe-8a7a-c9c9c9c9c9c9'; P = 'e4000000';
  writeFileSync(join(DIR, 'cycle-head.jsonl'), [
    rec(sid, u(P, 1), u(P, 2), 'user', 'An invented prompt on a cycle.'),
    rec(sid, u(P, 2), u(P, 1), 'assistant', 'An invented reply on a cycle.'),
    JSON.stringify({ parentUuid: null, logicalParentUuid: u(P, 6), ...env(sid), type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preservedSegment: { headUuid: u(P, 1), tailUuid: u(P, 6) } }, uuid: u(P, 3), timestamp: '2026-08-01T13:00:01.000Z' }),
    JSON.stringify({ parentUuid: u(P, 3), ...env(sid), type: 'user', isCompactSummary: true, message: { role: 'user', content: 'An invented summary.' }, uuid: u(P, 4), timestamp: '2026-08-01T13:00:02.000Z' }),
    rec(sid, u(P, 5), u(P, 4), 'user', 'An invented prompt after the compaction.'),
    rec(sid, u(P, 6), u(P, 5), 'assistant', 'An invented reply after the compaction.'),
    JSON.stringify({ type: 'last-prompt', lastPrompt: 'An invented prompt after the compaction.', leafUuid: u(P, 6), sessionId: sid }),
  ].join('\n') + '\n');
}

// content.jsonl: a result holding only an image (two different images must hash apart), and nulls inside content arrays
{
  const f = file('content.jsonl', 'f5f5f5f5-4444-4fcf-8b8b-dadadadadada', 'e5000000');
  f.prompt('Look at the two invented pictures.', { promptSource: 'typed' });
  f.use('toolu_content_01', 'Read', { file_path: '/work/demo-project/one.png' });
  f.result('toolu_content_01', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZQXD01aW52ZW50ZWQgb25l' } }]);
  f.use('toolu_content_02', 'Read', { file_path: '/work/demo-project/two.png' });
  f.result('toolu_content_02', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ZQXD02aW52ZW50ZWQgdHdv' } }]);
  f.use('toolu_content_03', 'Bash', { command: 'make demo' });
  f.result('toolu_content_03', [null, { type: 'text', text: 'the invented output after a null block' }]);
  // a null block directly in a message's content array (S3: every reader of block.type crashed on it)
  const a4 = f.uuid(40);
  f.raw({ parentUuid: f.last, isSidechain: false, userType: 'external', cwd: '/work/demo-project', version: '2.0.0', gitBranch: 'main', entrypoint: 'cli', sessionId: 'f5f5f5f5-4444-4fcf-8b8b-dadadadadada', type: 'assistant', message: { id: 'msg_content_04', type: 'message', role: 'assistant', model: 'claude-demo-model', content: [null, { type: 'tool_use', id: 'toolu_content_04', name: 'Bash', input: { command: 'make demo-two' } }], stop_reason: 'tool_use' }, requestId: 'req_content_04', uuid: a4, timestamp: '2026-08-01T10:09:00.000Z' });
  f.last = a4;
  f.result('toolu_content_04', 'the invented second output');
  f.text('Both invented pictures were seen.');
  f.leaf('Look at the two invented pictures.');
  f.write();
}
