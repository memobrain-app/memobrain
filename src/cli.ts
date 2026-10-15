#!/usr/bin/env node
// memobrain: the structure of Claude Code transcripts, without their content.
//
// Every turn and every tool call on a session's live path becomes one JSON line in which the
// payload is replaced by an ADDRESS (where it lives: <first 8 chars of the file name>:L<line>)
// and a HASH (which bytes were there: sha256, first 12 hex characters). The output can be read
// whole; a shape found in it is opened by its address, in the transcript itself, only where it
// matters.
//
// Reads only the files named on the command line. Writes only to stdout and stderr.
// No network, no telemetry.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { parseTranscript, repairedLivePath, turnsOf, inputChannel } from './parser.js';
import type { Transcript, TreeNode } from './parser.js';

/** A turn: where its prompt is, which channel it came through, and the prompt's length. */
interface TurnLine { k: 'turn'; a: string; ta: string; ch: string; n: number }
/** A tool call: where it is, a label for what it did, and hashes of what went in and came out.
 *  ok, r, out and n are null when no result was recorded. */
interface CallLine {
  k: 'call'; a: string; ta: string; tool: string; verb: string;
  in: string; ok: boolean | null; ek: string | undefined; r: string | null; out: string | null; n: number | null;
}
type SkeletonLine = TurnLine | CallLine;

/** Counts over one file's skeleton. */
interface StatsLine {
  session: string; turns: number; prompts: number; calls: number; failures: number; unanswered: number;
  errorClasses: Record<string, number>; retries: number; detours: number; maxHops: number; hopsOver2: number;
}

const USAGE = `Usage:
  memobrain skeleton <file.jsonl>...   one JSON line per turn and per tool call
  memobrain stats <file.jsonl>...      one JSON line of counts per file
  memobrain --help                     show the help, with every output field
  memobrain --version                  show the version
`;

const HELP = `memobrain: the structure of Claude Code transcripts, without their content.

${USAGE}
Claude Code keeps transcripts in ~/.claude/projects/<project>/<session>.jsonl.
memobrain reads only the files it is given, writes only to stdout and stderr,
and uses no network.

It follows each session's live path: the branch the session ended on, as the
transcript's own last-prompt record names it (without one, the deepest branch),
joined across compactions and late-written error records. Every payload is
replaced by an address and a hash. An address is <prefix>:L<line number>: the
prefix is the file name's first 8 characters, or, for a subagent's
agent-<id>.jsonl, agent- and the id's first 8.

skeleton, one line per turn:
  k             "turn"
  a             address of the prompt
  ta            turn id: <prefix>:T001, T002, ...
  ch            channel the prompt came through: typed, sdk, input, task,
                loop, parent, or the record's own word for another agent
                (for example peer)
  n             length of the prompt text (JavaScript string length)

skeleton, one line per tool call, after the turn it belongs to:
  k             "call"
  a             address of the tool call
  ta            the turn it belongs to
  tool          tool name
  verb          a short label for what the call did. Bash: the program in
                command position, after any cd DIR followed by && ; or a
                newline, NAME=value assignments, and the wrappers env, time,
                command, builtin, exec, nohup, nice and timeout (with their
                options); a path is cut to its last part, and a command that
                only assigns values is labelled by the command inside its
                first $(...). Read, Edit, Write, NotebookEdit: the file's
                extension (its name when it has none). Agent, Task: the
                subagent type. Skill: the skill name. Other tools: the name
  in            sha256 of the input as JSON (a missing input counts as {}),
                first 12 hex characters
  ok            true when the call succeeded, false when it failed, null when
                no result was recorded (the session ended, or the file was
                cut, before the call returned)
  ek            error class, only when the call failed: hook-block:<hook
                script name>, hook-block, no-anchor, not-read, exit-<code>,
                bad-input, denied, other
  r             address of the result, or null when none was recorded
  out           sha256 of the result text, first 12 hex characters (null when
                no result was recorded)
  n             length of the result text, JavaScript string length (null
                when no result was recorded)

A label (tool, verb, ch) is printed only when it looks like one: at most 64
letters, digits and . _ : + -. Anything else prints as (withheld).

stats, one line per file:
  session       the file's address prefix
  turns         turns on the live path
  prompts       turns opened by a prompt (channel typed, sdk or input)
  calls         tool calls
  failures      tool calls that failed
  unanswered    tool calls with no recorded result
  errorClasses  failures by error class
  retries       calls right after a failed call in the same turn, with the
                same tool
  detours       calls right after a failed call in the same turn, with a
                different tool
  maxHops       the longest chain of failures with one verb that a later
                success with that verb closed in the same turn, counting
                the success
  hopsOver2     chains of more than 2 hops

Warnings go to stderr: lines that are not JSON objects, files with nothing to
show (empty, a workflow journal, no conversation records, no turns), and
records whose parent links loop, so a zero never reads as a clean result.

Exit status: 0 when every file was processed, 1 when a file could not be read
or processed, 2 on a usage error.
`;

const TRANSCRIPTS_HINT = 'Claude Code keeps transcripts in ~/.claude/projects/<project>/<session>.jsonl.';

const h12 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12);
const pad3 = (n: number): string => String(n).padStart(3, '0');

/** Every label printed from a transcript (tool, verb, channel) must LOOK like a label: letters, digits
 *  and . _ : + -, at most 64 characters. Anything else is a value that may carry payload, and prints
 *  as (withheld). */
const LABEL = /^[\w.:+-]{1,64}$/;
const WITHHELD = '(withheld)';
const label = (v: unknown, fallback: string): string => (!v ? fallback : typeof v === 'string' && LABEL.test(v) ? v : WITHHELD);

// ---- the shell command's verb ---------------------------------------------------------------
// A small lexer, enough to find the word in COMMAND position: quotes, escapes, $(...), `...` and
// ${...} are read as parts of one word, so an argument, a quoted string or the output of a
// substitution can never be taken for the command.

type Tok = { op: string } | { word: string; plain: boolean };

function skipQuoted(s: string, j: number, close: string): number {
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && close !== "'") { j += 2; continue; }
    if (c === close) return j + 1;
    if (close === '"' && c === '$' && s[j + 1] === '(') { j = skipParen(s, j + 2); continue; }
    if (close === '"' && c === '`') { j = skipQuoted(s, j + 1, '`'); continue; }
    j++;
  }
  return s.length;
}
/** From just after "$(" (or "${" with open "{"), the index just after the matching close. */
function skipParen(s: string, j: number, open = '(', close = ')'): number {
  let depth = 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { j = skipQuoted(s, j + 1, c); continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
    j++;
  }
  return s.length;
}

/** The first tokens of a command line: words, and the operators between them. */
function lex(s: string, max = 64): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < s.length && toks.length < max) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '\\' && s[i + 1] === '\n') { i += 2; continue; }
    if (c === '\n') { toks.push({ op: '\n' }); i++; continue; }
    if (c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    const two = s.slice(i, i + 2);
    if (two === '&&' || two === '||') { toks.push({ op: two }); i += 2; continue; }
    if (c === '<' || c === '>') { let j = i; while (j < s.length && '<>&|'.includes(s[j])) j++; toks.push({ op: '<' }); i = j; continue; }
    if (';&|()'.includes(c)) { toks.push({ op: c }); i++; continue; }
    let j = i, plain = true;
    while (j < s.length) {
      const d = s[j];
      if (d === '(' && /^[A-Za-z_]\w*\+?=$/.test(s.slice(i, j))) { plain = false; j = skipParen(s, j + 1); continue; }   // NAME=(array)
      if (' \t\r\n;&|()<>'.includes(d)) break;
      if (d === '\\') { plain = false; j += 2; continue; }
      if (d === "'" || d === '"' || d === '`') { plain = false; j = skipQuoted(s, j + 1, d); continue; }
      if (d === '$' && s[j + 1] === '(') { plain = false; j = skipParen(s, j + 2); continue; }
      if (d === '$' && s[j + 1] === '{') { plain = false; j = skipParen(s, j + 2, '{', '}'); continue; }
      if ('$*?['.includes(d)) plain = false;
      j++;
    }
    toks.push({ word: s.slice(i, j), plain });
    i = j;
  }
  return toks;
}

/** The text inside the first $(...) or `...` of an assignment's value (single quotes are literal). */
function firstSubstitution(w: string): string | undefined {
  for (let j = w.indexOf('=') + 1; j < w.length; j++) {
    const c = w[j];
    if (c === '\\') { j++; continue; }
    if (c === "'") { j = skipQuoted(w, j + 1, "'") - 1; continue; }
    if (c === '$' && w[j + 1] === '(' && w[j + 2] !== '(') return w.slice(j + 2, skipParen(w, j + 2) - 1);
    if (c === '`') return w.slice(j + 1, skipQuoted(w, j + 1, '`') - 1);
  }
  return undefined;
}

const ASSIGNMENT = /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/;
/** Wrappers that run the command after them, and the options of theirs that take an argument. */
const WRAPPERS: Record<string, string[]> = {
  env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'], time: [], command: [], builtin: [],
  exec: ['-a'], nohup: [], nice: ['-n', '--adjustment'], timeout: ['-s', '--signal', '-k', '--kill-after'],
};

/** The program a command word names: its last path part, when that part is a literal label. Quotes
 *  around a literal word are not part of the name; an expansion in the directory part does not
 *  matter (`$DIR/run.sh` is run.sh), anywhere else it withholds the word. */
function commandLabel(w: string): string {
  if (w === '[' || w === '[[') return w;
  const last = w.slice(w.lastIndexOf('/') + 1);
  return /[$`\\]/.test(last) ? WITHHELD : label(last.replace(/["']/g, ''), WITHHELD);
}

/** Bash: the first word in command position. Passed over on the way: separators, `!`, `{`, `(`,
 *  redirections, `cd DIR` followed by && ; or a newline, `NAME=value` assignments, and the
 *  wrappers above with their options (and timeout's duration). A command that only assigns values
 *  is labelled by the command inside its first $(...) or `...`. `[` and `[[` are labels of their own. */
function bashVerb(command: string, depth = 0): string {
  const toks = lex(command);
  const redirection = (x: Tok | undefined) => x !== undefined && 'op' in x && x.op === '<';
  let k = 0, sub: string | undefined;
  while (k < toks.length) {
    const t = toks[k];
    if ('op' in t) { k += t.op === '<' ? 2 : 1; continue; }        // a redirection's target goes with it
    const w = t.word;
    if (w === '!' || w === '{') { k++; continue; }
    if (/^\d+$/.test(w) && redirection(toks[k + 1])) { k += 3; continue; }
    if (ASSIGNMENT.test(w)) { sub ??= firstSubstitution(w); k++; continue; }
    if (w === 'cd') {
      let m = k + 1;
      while (m < toks.length && ('word' in toks[m] || redirection(toks[m]))) m += redirection(toks[m]) ? 2 : 1;
      const sep = toks[m];
      if (sep && 'op' in sep && (sep.op === '&&' || sep.op === ';' || sep.op === '\n')) { k = m + 1; continue; }
      return 'cd';
    }
    if (t.plain && Object.hasOwn(WRAPPERS, w)) {
      const withArg = WRAPPERS[w];
      k++;
      while (k < toks.length && 'word' in toks[k]) {
        const o = (toks[k] as { word: string }).word;
        if (o.startsWith('-')) { k += withArg.includes(o) ? 2 : 1; continue; }
        if (w === 'env' && ASSIGNMENT.test(o)) { k++; continue; }
        break;
      }
      if (w === 'timeout' && k < toks.length && 'word' in toks[k]) k++;   // the duration
      continue;
    }
    return commandLabel(w);
  }
  if (sub !== undefined && depth < 3) return bashVerb(sub, depth + 1);
  return '(empty)';
}

/** A short label for what a call did, read from its input; the input itself is never printed.
 *  Bash: see bashVerb. Read, Edit, Write, NotebookEdit: the file's extension, or its name when it
 *  has none (a path is cut at / and at \). Agent, Task: the subagent type. Skill: the skill. Else
 *  the tool's name. Every label passes LABEL or prints as (withheld). */
function verbOf(tool: string, input?: Record<string, any> | null): string {
  const inp = input ?? {};
  if (tool === 'Bash') return bashVerb(String(inp.command || ''));
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool)) {
    const name = String(inp.file_path || inp.notebook_path || '').split(/[\\/]/).pop() || '';
    return label(extname(name) || name, '(none)');
  }
  if (tool === 'Agent' || tool === 'Task') return label(inp.subagent_type, 'agent');
  if (tool === 'Skill') return label(inp.skill, 'skill');
  return label(tool, WITHHELD);
}

/** A failed call's error CLASS, by fixed rules over the result text: a label, never the text.
 *  A hook block carries the hook script's name (without its extension): a label, not payload. */
function errorClass(text: string): string {
  const first = text.split('\n').find((l) => l.trim()) || '';
  if (/^PreToolUse:|hook error|blocked by .*hook/i.test(first)) {
    const h = /\[(?:bash |node |python3 )?[^\]]*?([\w.-]+)\.(?:sh|mjs|js|py)\b/.exec(first);
    return h ? `hook-block:${h[1]}` : 'hook-block';
  }
  if (/String to replace not found/.test(text)) return 'no-anchor';
  if (/has not been read yet|must (?:first )?read/i.test(text)) return 'not-read';
  const ex = /Exit code (\d+)/.exec(text);
  if (ex) return `exit-${ex[1]}`;
  if (/InputValidationError|invalid input/i.test(first)) return 'bad-input';
  if (/denied|not permitted|permission/i.test(first)) return 'denied';
  return 'other';
}

/** Content as one string: a string as it is; an array of blocks as their texts joined by newlines. */
const flat = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => (typeof x === 'string' ? x : x?.text ?? '')).join('\n') : '');
const promptLen = (rec: any): number => flat(rec?.message?.content).length;

/** The address prefix: the file name's first 8 characters. A subagent's transcript is named
 *  agent-<id>.jsonl, and those names share their first 8 characters, so there it is agent- and the
 *  id's first 8. */
function prefixOf(file: string): string {
  const name = basename(file);
  return name.startsWith('agent-') ? `agent-${name.slice(6, 14)}` : name.slice(0, 8);
}

/** One line per input turn and per tool call on the live path, in path order. A call whose result
 *  was never recorded has ok, r, out and n null. */
function skeletonOf(file: string, t: Transcript): SkeletonLine[] {
  const pre = prefixOf(file);
  const at = (n: TreeNode) => `${pre}:L${t.positions[n.index].line}`;
  const turns = turnsOf(t, repairedLivePath(t).path);
  const lines: SkeletonLine[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i], ta = `${pre}:T${pad3(i + 1)}`;
    lines.push({ k: 'turn', a: at(turn.prompt), ta, ch: label(inputChannel(turn.prompt.record), 'none'), n: promptLen(turn.prompt.record) });
    for (const c of turn.toolCalls) {
      const answered = c.resultBlock !== undefined, rt = flat(c.resultBlock?.content);
      lines.push({ k: 'call', a: at(c.callNode), ta, tool: label(c.name, WITHHELD), verb: verbOf(c.name, c.input),
        in: h12(JSON.stringify(c.input ?? {})), ok: answered ? !c.isError : null, ek: answered && c.isError ? errorClass(rt) : undefined,
        r: c.resultNode ? at(c.resultNode) : null, out: answered ? h12(rt) : null, n: answered ? rt.length : null });
    }
  }
  return lines;
}

/** The skeleton's shapes, counted: what follows a failed call, and how many calls a chain of
 *  failures with one verb took to come good. Everything is counted within a turn. A call with no
 *  recorded result is neither a failure nor a success: it is counted as unanswered and leaves a
 *  chain as it was. */
function statsOf(file: string, lines: SkeletonLine[]): StatsLine {
  const s: StatsLine = { session: prefixOf(file), turns: 0, prompts: 0, calls: 0, failures: 0, unanswered: 0, errorClasses: {}, retries: 0, detours: 0, maxHops: 0, hopsOver2: 0 };
  let prev: CallLine | null = null, run = 0, runVerb: string | null = null;
  for (const r of lines) {
    if (r.k === 'turn') { s.turns++; if (r.ch === 'typed' || r.ch === 'sdk' || r.ch === 'input') s.prompts++; prev = null; run = 0; runVerb = null; continue; }
    s.calls++;
    if (r.ok === null) s.unanswered++;
    if (r.ok === false) { const ek = r.ek ?? 'other'; s.failures++; s.errorClasses[ek] = (s.errorClasses[ek] || 0) + 1; }
    if (prev && prev.ok === false) { if (r.tool === prev.tool) s.retries++; else s.detours++; }
    if (r.ok === false) { run = r.verb === runVerb ? run + 1 : 1; runVerb = r.verb; }
    else if (r.ok === true && r.verb === runVerb && run) { s.maxHops = Math.max(s.maxHops, run + 1); if (run + 1 > 2) s.hopsOver2++; run = 0; runVerb = null; }
    prev = r;
  }
  return s;
}

/** Records reachable from no root and no orphan: they sit on a parentUuid cycle, or below one. */
function cycleRecords(t: Transcript): number {
  const seen = new Set<TreeNode>(), stack = [...t.roots, ...t.orphans];
  while (stack.length) { const n = stack.pop()!; if (seen.has(n)) continue; seen.add(n); stack.push(...n.children); }
  return t.nodes.size - seen.size;
}

/** Why a file that parsed still has nothing to show, so a zero never reads as a clean result. */
function warningsFor(cmd: string, file: string, t: Transcript, lineCount: number): string[] {
  const warnings: string[] = [];
  const consequence = cmd === 'stats' ? 'its counts are 0' : 'it adds no lines';
  const p = t.problems.length;
  if (p) warnings.push(`memobrain ${cmd}: warning: '${file}': ${p} line${p === 1 ? '' : 's'} could not be read as a JSON object (first: line ${t.problems[0].line}) and ${p === 1 ? 'was' : 'were'} skipped.`);
  if (t.fileKind === 'empty') warnings.push(`memobrain ${cmd}: warning: '${file}' holds no records, so ${consequence}.`);
  else if (t.fileKind === 'journal') warnings.push(`memobrain ${cmd}: warning: '${file}' is a workflow journal (launched, started and result records only), not a conversation, so ${consequence}.`);
  else if (t.fileKind === 'unknown') {
    const types = [...new Set(t.records.map((r) => (typeof r.type === 'string' ? r.type : '(none)')))].sort();
    const shown = types.slice(0, 6).join(', ') + (types.length > 6 ? `, and ${types.length - 6} more` : '');
    warnings.push(`memobrain ${cmd}: warning: '${file}' has no conversation records (no record carries both uuid and parentUuid; record types found: ${shown}), so ${consequence}. Conversation transcripts are the <session>.jsonl files in ~/.claude/projects/<project>/ and the agent-<id>.jsonl files under <session>/subagents/.`);
  }
  else if (lineCount === 0) warnings.push(`memobrain ${cmd}: warning: '${file}' has conversation records but no turn on its live path, so ${consequence}.`);
  const c = t.fileKind === 'transcript' ? cycleRecords(t) : 0;
  if (c) warnings.push(`memobrain ${cmd}: warning: '${file}': ${c} record${c === 1 ? '' : 's'} sit${c === 1 ? 's' : ''} on a parentUuid cycle or below one (following the parent links never reaches the start of the session), so the live path through ${c === 1 ? 'it' : 'them'} may be incomplete.`);
  return warnings;
}

function cannotRead(cmd: string, file: string, e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return `memobrain ${cmd}: cannot read '${file}': no such file or directory. Check the path. ${TRANSCRIPTS_HINT}`;
  if (code === 'EISDIR') return `memobrain ${cmd}: '${file}' is a directory. Pass the .jsonl files inside it, e.g. memobrain ${cmd} ${file.replace(/\/+$/, '')}/*.jsonl`;
  if (code === 'EACCES' || code === 'EPERM') return `memobrain ${cmd}: cannot read '${file}': permission denied. Check its permissions with: ls -l '${file}'`;
  if (code === 'ERR_STRING_TOO_LONG') return `memobrain ${cmd}: cannot read '${file}': the file is too large to load as one string (the limit is about 512 MB).`;
  return `memobrain ${cmd}: cannot read '${file}': ${(e as Error)?.message ?? String(e)}`;
}

function readVersion(): string {
  return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
}

const out = (s: string): void => { if (s) process.stdout.write(s); };
const err = (s: string): void => { process.stderr.write(s.endsWith('\n') ? s : s + '\n'); };

function main(argv: string[]): number {
  const cmd = argv[0];
  if (cmd === undefined) { err(`memobrain: no command given.\n\n${USAGE}`); return 2; }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') { out(HELP); return 0; }
  if (cmd === '--version' || cmd === '-v') {
    try { out(readVersion() + '\n'); return 0; }
    catch (e) { err(`memobrain: cannot read the version from package.json next to this program: ${(e as Error)?.message ?? String(e)}`); return 1; }
  }
  if (cmd !== 'skeleton' && cmd !== 'stats') {
    if (cmd.startsWith('-')) err(`memobrain: unknown option '${cmd}'. The options are --help and --version.\n\n${USAGE}`);
    else err(`memobrain: unknown command '${cmd}'. The commands are skeleton and stats.\n\n${USAGE}`);
    return 2;
  }

  const files: string[] = [];
  let optionsEnded = false;
  for (const a of argv.slice(1)) {
    if (!optionsEnded && a === '--') { optionsEnded = true; continue; }
    if (!optionsEnded && (a === '--help' || a === '-h')) { out(HELP); return 0; }
    if (!optionsEnded && a === '-') { err(`memobrain ${cmd}: reading from standard input ('-') is not supported. Pass the transcript's path, e.g. memobrain ${cmd} ~/.claude/projects/<project>/<session>.jsonl`); return 2; }
    if (!optionsEnded && a.startsWith('-')) { err(`memobrain ${cmd}: unknown option '${a}'. ${cmd} takes file names only; put -- before a file name that starts with '-'.`); return 2; }
    files.push(a);
  }
  if (!files.length) { err(`memobrain ${cmd}: no input files. Pass one or more transcripts, e.g. memobrain ${cmd} ~/.claude/projects/<project>/<session>.jsonl`); return 2; }

  let failed = 0;
  for (const file of files) {
    let text: string;
    try { text = readFileSync(file, 'utf8'); }
    catch (e) { err(cannotRead(cmd, file, e)); failed++; continue; }
    try {
      const t = parseTranscript(text);
      const lines = skeletonOf(file, t);
      for (const w of warningsFor(cmd, file, t, lines.length)) err(w);
      out(cmd === 'skeleton' ? lines.map((l) => JSON.stringify(l) + '\n').join('') : JSON.stringify(statsOf(file, lines)) + '\n');
    } catch (e) {
      err(`memobrain ${cmd}: '${file}': stopped with an internal error, so nothing was written for it: ${(e as Error)?.message ?? String(e)}. This is a bug in memobrain; the other files are processed as usual.`);
      failed++;
    }
  }
  if (failed) { err(`memobrain ${cmd}: ${files.length - failed} of ${files.length} files done; ${failed} failed, as reported above.`); return 1; }
  return 0;
}

// A reader that stops early (e.g. `| head`) closes the pipe: stop quietly, it is not an error here.
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0);
  throw e;
});
process.exitCode = main(process.argv.slice(2));
