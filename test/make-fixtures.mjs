// Writes the generated test fixtures: labels.jsonl, unanswered.jsonl, cycle.jsonl, rare-shapes.jsonl and
// journal-launched.jsonl. Every string in them is invented; the record format follows the hand-written
// fixtures (edges.jsonl). The output is the same on every run.
//
//   node test/make-fixtures.mjs test/fixtures
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const DIR = process.argv[2];
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
  f.result('toolu_rare_02', 'PreToolUse:Read [node /work/demo-project/.claude/hooks/demo-guard.mjs] refused: reads outside the demo project', { isError: true });
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

