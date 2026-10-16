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
transcript's own last-prompt record names it (without one, the branch of the
last record written), joined across compactions and late-written error records. Every payload is
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
                first $(...); a wrapper with nothing after it is the program.
                The reading fails closed: a here-document, an arithmetic
                command, a case inside $(...), an unclosed quote or an unknown
                wrapper option before the program, or a function definition,
                gives (withheld). Read, Edit, Write, NotebookEdit: the file's
                extension (its name when it has none). Agent, Task: the
                subagent type. Skill: the skill name. Other tools: the name
  in            sha256 of the input as JSON (a missing input counts as {}),
                first 12 hex characters
  ok            true when the call succeeded, false when it failed, null when
                no result was recorded (the session ended, or the file was
                cut, before the call returned)
  ek            error class, only when the call failed: hook-block:<hook
                script name> or hook-block (Claude Code's own format only:
                PreToolUse:<tool> hook error: [<command>]), no-anchor,
                not-read, exit-<code> (the leading "Exit code N"), bad-input,
                denied, other
  r             address of the result, or null when none was recorded
  out           sha256 of the result text, first 12 hex characters; of the
                whole result as JSON when it holds anything but text (null
                when no result was recorded)
  n             length of the result text, JavaScript string length (null
                when no result was recorded)

A label (tool, verb, ch, the hook name in ek) is printed only when it looks
like one: at most 64 letters, digits and . _ : + - (a file name or extension:
without ':'; the shell's [ and [[ as they are). Anything else prints as
(withheld).

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
const h12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const pad3 = (n) => String(n).padStart(3, '0');
/** Every label printed from a transcript must LOOK like a label: letters, digits and . _ : + -, at most 64
 *  characters; a file's name or extension, the same without ':'. Anything else is a value that may carry payload,
 *  and prints as (withheld). */
const LABEL = /^[\w.:+-]{1,64}$/;
const FILE_LABEL = /^[\w.+-]{1,64}$/;
const WITHHELD = '(withheld)';
const label = (v, fallback, re = LABEL) => (!v ? fallback : typeof v === 'string' && re.test(v) ? v : WITHHELD);
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
// ---- the shell command's verb ---------------------------------------------------------------
// A small lexer that FAILS CLOSED. It names the word in COMMAND position only when everything before that word is
// understood: plain words, quotes ($'...' with its escapes), $(...), `...`, ${...} with quotes nested in it, $((...)),
// $[...], NAME=(arrays), redirections, comments. Anything it does not model, met BEFORE the verb (a here-document, an
// arithmetic command ((...)), a case inside $(...), an unclosed quote or substitution, a wrapper option it does not
// know, more than 64 tokens), makes the verb (withheld): a wrong guess could print a word of payload, a withheld verb
// cannot. Tokens are read lazily, so what comes AFTER the verb (cat <<EOF, python3 - <<'EOF') is never examined.
class Unsure extends Error {
}
/** From just after an opening quote, the index just after its close. ' has no escapes; $'...' and the others do;
 *  " holds $(...), ${...} and `...`. A quote never closed is Unsure. */
function skipQuoted(s, j, close, ansi = false, depth = 0) {
    if (depth > 40)
        throw new Unsure();
    while (j < s.length) {
        const c = s[j];
        if (c === '\\' && (close !== "'" || ansi)) {
            j += 2;
            continue;
        }
        if (c === close)
            return j + 1;
        if (close === '"' && c === '$' && (s[j + 1] === '(' || s[j + 1] === '{')) {
            j = skipParen(s, j + 2, s[j + 1], s[j + 1] === '(' ? ')' : '}', depth + 1);
            continue;
        }
        if (close === '"' && c === '`') {
            j = skipQuoted(s, j + 1, '`', false, depth + 1);
            continue;
        }
        j++;
    }
    throw new Unsure();
}
const wordStart = (s, j, start) => j === start || /[\s;&|(]/.test(s[j - 1]);
/** From just after an opener, the index just after the matching closer, with quotes, comments and nesting read.
 *  A here-document or a case inside, or a closer never found, is Unsure. */
function skipParen(s, j, open = '(', close = ')', depth = 0) {
    if (depth > 40)
        throw new Unsure();
    const start = j;
    let d = 1;
    while (j < s.length) {
        const c = s[j];
        if (c === '\\') {
            j += 2;
            continue;
        }
        if (c === "'") {
            j = skipQuoted(s, j + 1, "'", s[j - 1] === '$', depth + 1);
            continue;
        }
        if (c === '"' || c === '`') {
            j = skipQuoted(s, j + 1, c, false, depth + 1);
            continue;
        }
        if (c === '#' && wordStart(s, j, start)) {
            while (j < s.length && s[j] !== '\n')
                j++;
            continue;
        }
        if (c === '<' && s[j + 1] === '<' && s[j + 2] !== '<')
            throw new Unsure();
        if (open === '(' && s.startsWith('case', j) && !/\w/.test(s[j + 4] ?? '') && wordStart(s, j, start))
            throw new Unsure();
        if (c === open)
            d++;
        else if (c === close && --d === 0)
            return j + 1;
        j++;
    }
    throw new Unsure();
}
/** The tokens of a command line, one at a time: words, and the operators between them. */
function* tokens(s) {
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === ' ' || c === '\t' || c === '\r') {
            i++;
            continue;
        }
        if (c === '\\' && s[i + 1] === '\n') {
            i += 2;
            continue;
        }
        if (c === '\n') {
            yield { op: '\n' };
            i++;
            continue;
        }
        if (c === '#') {
            while (i < s.length && s[i] !== '\n')
                i++;
            continue;
        }
        if (s.startsWith('((', i))
            throw new Unsure(); // an arithmetic command
        const two = s.slice(i, i + 2);
        if (two === '&&' || two === '||') {
            yield { op: two };
            i += 2;
            continue;
        }
        if (c === '<' || c === '>' || two === '&>') {
            let j = i;
            while (j < s.length && '<>&|'.includes(s[j]))
                j++;
            if (s.startsWith('<<', i) && !s.startsWith('<<<', i))
                throw new Unsure(); // a here-document
            yield { op: '<' };
            i = j;
            continue;
        }
        if (';&|()'.includes(c)) {
            yield { op: c };
            i++;
            continue;
        }
        let j = i, plain = true;
        while (j < s.length) {
            const d = s[j];
            if (d === '(' && /^[A-Za-z_]\w*\+?=$/.test(s.slice(i, j))) {
                plain = false;
                j = skipParen(s, j + 1);
                continue;
            } // NAME=(array)
            if (' \t\r\n;&|()<>'.includes(d))
                break;
            if (d === '\\') {
                plain = false;
                j += 2;
                continue;
            }
            if (d === '$' && s[j + 1] === "'") {
                plain = false;
                j = skipQuoted(s, j + 2, "'", true);
                continue;
            }
            if (d === "'" || d === '"' || d === '`') {
                plain = false;
                j = skipQuoted(s, j + 1, d);
                continue;
            }
            if (d === '$' && (s[j + 1] === '(' || s[j + 1] === '{' || s[j + 1] === '[')) {
                plain = false;
                j = skipParen(s, j + 2, s[j + 1], s[j + 1] === '(' ? ')' : s[j + 1] === '{' ? '}' : ']');
                continue;
            }
            if ('$*?['.includes(d))
                plain = false;
            j++;
        }
        yield { word: s.slice(i, j), plain };
        i = j;
    }
}
/** The text inside the first $(...) or `...` of an assignment's value, quotes read as bash reads them. */
function firstSubstitution(w) {
    let j = w.indexOf('=') + 1, dq = false;
    while (j < w.length) {
        const c = w[j];
        if (c === '\\') {
            j += 2;
            continue;
        }
        if (!dq && c === "'") {
            j = skipQuoted(w, j + 1, "'", w[j - 1] === '$');
            continue;
        }
        if (c === '"') {
            dq = !dq;
            j++;
            continue;
        }
        if (c === '$' && w[j + 1] === '(' && w[j + 2] !== '(')
            return w.slice(j + 2, skipParen(w, j + 2) - 1);
        if (c === '$' && (w[j + 1] === '{' || w[j + 1] === '(' || w[j + 1] === '[')) {
            j = skipParen(w, j + 2, w[j + 1], w[j + 1] === '{' ? '}' : w[j + 1] === '(' ? ')' : ']');
            continue;
        }
        if (c === '`')
            return w.slice(j + 1, skipQuoted(w, j + 1, '`') - 1);
        j++;
    }
    if (dq)
        throw new Unsure();
    return undefined;
}
const ASSIGNMENT = /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/;
/** Wrappers that run the command after them: their options without and with an argument. An option outside
 *  these lists might take an argument, so it withholds the verb rather than guess. */
const WRAPPERS = {
    env: { flags: ['-', '-i', '-0', '-v', '--ignore-environment', '--null', '--debug'], withArg: ['-u', '-C', '-P', '-a', '--unset', '--chdir', '--argv0'] },
    time: { flags: ['-p', '-a', '-v', '-q', '--portability', '--append', '--verbose', '--quiet'], withArg: ['-o', '-f', '--output', '--format'] },
    timeout: { flags: ['-v', '--verbose', '--preserve-status', '--foreground'], withArg: ['-s', '-k', '--signal', '--kill-after'] },
    nice: { flags: [], withArg: ['-n', '--adjustment'] },
    nohup: { flags: [], withArg: [] },
    command: { flags: ['-p', '-v', '-V'], withArg: [] },
    builtin: { flags: [], withArg: [] },
    exec: { flags: ['-c', '-l'], withArg: ['-a'] },
};
/** Bash: the program in command position. Passed over on the way: separators, !, {, (, redirections, cd DIR
 *  followed by && ; or a newline, NAME=value assignments, and the wrappers above with their options (and timeout's
 *  duration); a wrapper with nothing after it is the program itself. A command that only assigns values is
 *  labelled by the command inside its first $(...). [ and [[ are labels of their own; a function definition is
 *  withheld. */
function bashVerb(command, depth = 0) {
    try {
        return readVerb(command, depth);
    }
    catch (e) {
        if (e instanceof Unsure)
            return WITHHELD;
        throw e;
    }
}
function readVerb(command, depth) {
    const it = tokens(command), buf = [];
    let ended = false;
    const at = (k) => {
        while (buf.length <= k && !ended) {
            if (buf.length >= 64)
                throw new Unsure();
            const n = it.next();
            if (n.done)
                ended = true;
            else
                buf.push(n.value);
        }
        return buf[k];
    };
    // the verb is already certain when this looks one token on: what it cannot read there is not a definition
    const peek = (k) => { try {
        return at(k);
    }
    catch (e) {
        if (e instanceof Unsure)
            return undefined;
        throw e;
    } };
    const op = (t, o) => t !== undefined && 'op' in t && (o === undefined || t.op === o);
    const word = (t) => t !== undefined && 'word' in t;
    let k = 0, sub;
    for (;;) {
        const t = at(k);
        if (t === undefined)
            break;
        if (!word(t)) {
            k += t.op === '<' ? 2 : 1;
            continue;
        } // a redirection's target goes with it
        const w = t.word;
        if (w === '!' || w === '{') {
            k++;
            continue;
        }
        if (/^\d+$/.test(w) && op(at(k + 1), '<')) {
            k += 3;
            continue;
        }
        if (ASSIGNMENT.test(w)) {
            sub ??= firstSubstitution(w);
            k++;
            continue;
        }
        if (w === 'cd') {
            let m = k + 1;
            for (;;) {
                const x = at(m);
                if (word(x)) {
                    m++;
                    continue;
                }
                if (op(x, '<')) {
                    m += 2;
                    continue;
                }
                break;
            }
            const sep = at(m);
            if (op(sep, '&&') || op(sep, ';') || op(sep, '\n')) {
                k = m + 1;
                continue;
            }
            return 'cd';
        }
        if (t.plain && Object.hasOwn(WRAPPERS, w)) {
            const { flags, withArg } = WRAPPERS[w];
            let m = k + 1;
            for (;;) {
                const x = at(m);
                if (!word(x))
                    break;
                const o = x.word, eq = o.indexOf('=');
                if (o === '--') {
                    m++;
                    break;
                }
                if (!o.startsWith('-') || (o === '-' && w !== 'env'))
                    break;
                if (w === 'nice' && /^-\d+$/.test(o)) {
                    m++;
                    continue;
                }
                if (flags.includes(o)) {
                    m++;
                    continue;
                }
                if (withArg.includes(o)) {
                    m += 2;
                    continue;
                }
                if (o.startsWith('--') && eq > 0 && withArg.includes(o.slice(0, eq))) {
                    m++;
                    continue;
                }
                if (/^-[A-Za-z]./.test(o) && withArg.includes(o.slice(0, 2))) {
                    m++;
                    continue;
                } // -n10, -uNAME
                throw new Unsure();
            }
            if (w === 'env')
                while (word(at(m)) && ASSIGNMENT.test(at(m).word))
                    m++;
            if (w === 'timeout' && word(at(m)))
                m++; // the duration
            if (!word(at(m)))
                return w; // the wrapper alone: `env | grep x` runs env
            k = m;
            continue;
        }
        if (w === 'function' || (op(peek(k + 1), '(') && op(peek(k + 2), ')')))
            return WITHHELD; // a definition, not a program
        if (w === '[' || w === '[[')
            return w;
        const last = w.slice(w.lastIndexOf('/') + 1);
        return /[$`\\]/.test(last) ? WITHHELD : label(last.replace(/["']/g, ''), WITHHELD);
    }
    if (sub !== undefined)
        return depth < 3 ? readVerb(sub, depth + 1) : WITHHELD;
    return '(empty)';
}
const FILE_TOOLS = ['Read', 'Edit', 'Write', 'NotebookEdit'];
/** A short label for what a call did, read from its input; the input itself is never printed.
 *  Bash: see bashVerb. Read, Edit, Write, NotebookEdit: the file's extension, or its name when it has none (a path
 *  is cut at / and at \). Agent, Task: the subagent type. Skill: the skill. Else the tool's name. A value that is
 *  not a string, or not label-shaped, prints as (withheld). */
function verbOf(tool, input) {
    const inp = isRecord(input) ? input : {};
    if (tool === 'Bash') {
        const c = inp.command;
        return typeof c === 'string' ? bashVerb(c) : c === undefined || c === null ? '(empty)' : WITHHELD;
    }
    if (FILE_TOOLS.includes(tool)) {
        const p = inp.file_path ?? inp.notebook_path;
        if (p === undefined || p === null || p === '')
            return '(none)';
        if (typeof p !== 'string')
            return WITHHELD;
        const name = p.split(/[\\/]/).pop() || '';
        return label(extname(name) || name, '(none)', FILE_LABEL);
    }
    if (tool === 'Agent' || tool === 'Task')
        return label(inp.subagent_type, 'agent');
    if (tool === 'Skill')
        return label(inp.skill, 'skill');
    return label(tool, WITHHELD);
}
/** A failed call's error CLASS, by fixed rules over the result's first line: a label, never the text. A hook
 *  block is recognised only in the harness's own format (PreToolUse:<tool> hook error: [<command>]: ...), and the
 *  hook script's name, read inside those brackets, passes the label rule or the class is plain hook-block. An exit
 *  code is read only from the harness's leading "Exit code N". */
function errorClass(text) {
    const first = (text.split('\n').find((l) => l.trim()) || '').slice(0, 400);
    const hook = /^PreToolUse:[\w.:-]* hook error: \[([^\]]{0,300})\]/.exec(first);
    if (hook) {
        const m = /([\w.-]+)\.(?:sh|bash|mjs|cjs|js|ts|py|rb|pl)$/.exec(hook[1].trim().split(/\s+/).pop() ?? '');
        return m && FILE_LABEL.test(m[1]) && m[1].length <= 48 ? `hook-block:${m[1]}` : 'hook-block';
    }
    if (/String to replace not found/.test(text))
        return 'no-anchor';
    if (/has not been read yet|must (?:first )?read/i.test(text))
        return 'not-read';
    const ex = /^\s*Exit code (\d{1,3})\b/.exec(first);
    if (ex)
        return `exit-${ex[1]}`;
    if (/InputValidationError|invalid input/i.test(first))
        return 'bad-input';
    if (/denied|not permitted|permission/i.test(first))
        return 'denied';
    return 'other';
}
/** Content as one string: a string as it is; an array as its text blocks (and bare strings) joined by newlines. */
const flat = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : typeof x?.text === 'string' ? x.text : '')).join('\n') : '');
/** What a result's hash covers: its text, or, when it holds anything else (an image), the whole content as JSON. */
const hashed = (c) => (Array.isArray(c) && c.some((x) => isRecord(x) && x.type !== 'text') ? JSON.stringify(c) : flat(c));
const promptLen = (rec) => flat(rec?.message?.content).length;
/** The address prefix: the file name's first 8 characters. A subagent's transcript is named
 *  agent-<id>.jsonl, and those names share their first 8 characters, so there it is agent- and the
 *  id's first 8. */
function prefixOf(file) {
    const name = basename(file);
    return name.startsWith('agent-') ? `agent-${name.slice(6, 14)}` : name.slice(0, 8);
}
/** One line per input turn and per tool call on the live path, in path order. A call whose result
 *  was never recorded has ok, r, out and n null. */
function skeletonOf(file, t) {
    const pre = prefixOf(file);
    const at = (n) => `${pre}:L${t.positions[n.index].line}`;
    const turns = turnsOf(t, repairedLivePath(t).path);
    const lines = [];
    for (let i = 0; i < turns.length; i++) {
        const turn = turns[i], ta = `${pre}:T${pad3(i + 1)}`;
        lines.push({ k: 'turn', a: at(turn.prompt), ta, ch: label(inputChannel(turn.prompt.record), 'none'), n: promptLen(turn.prompt.record) });
        for (const c of turn.toolCalls) {
            const answered = c.resultBlock !== undefined, rt = flat(c.resultBlock?.content);
            lines.push({ k: 'call', a: at(c.callNode), ta, tool: label(c.name, WITHHELD), verb: verbOf(c.name, c.input),
                in: h12(JSON.stringify(c.input ?? {})), ok: answered ? !c.isError : null, ek: answered && c.isError ? errorClass(rt) : undefined,
                r: c.resultNode ? at(c.resultNode) : null, out: answered ? h12(hashed(c.resultBlock?.content)) : null, n: answered ? rt.length : null });
        }
    }
    return lines;
}
/** The skeleton's shapes, counted: what follows a failed call, and how many calls a chain of
 *  failures with one verb took to come good. Everything is counted within a turn. A call with no
 *  recorded result is neither a failure nor a success: it is counted as unanswered and leaves a
 *  chain as it was. */
function statsOf(file, lines) {
    const s = { session: prefixOf(file), turns: 0, prompts: 0, calls: 0, failures: 0, unanswered: 0, errorClasses: {}, retries: 0, detours: 0, maxHops: 0, hopsOver2: 0 };
    let prev = null, run = 0, runVerb = null;
    for (const r of lines) {
        if (r.k === 'turn') {
            s.turns++;
            if (r.ch === 'typed' || r.ch === 'sdk' || r.ch === 'input')
                s.prompts++;
            prev = null;
            run = 0;
            runVerb = null;
            continue;
        }
        s.calls++;
        if (r.ok === null)
            s.unanswered++;
        if (r.ok === false) {
            const ek = r.ek ?? 'other';
            s.failures++;
            s.errorClasses[ek] = (s.errorClasses[ek] || 0) + 1;
        }
        if (prev && prev.ok === false) {
            if (r.tool === prev.tool)
                s.retries++;
            else
                s.detours++;
        }
        if (r.ok === false) {
            run = r.verb === runVerb ? run + 1 : 1;
            runVerb = r.verb;
        }
        else if (r.ok === true && r.verb === runVerb && run) {
            s.maxHops = Math.max(s.maxHops, run + 1);
            if (run + 1 > 2)
                s.hopsOver2++;
            run = 0;
            runVerb = null;
        }
        prev = r;
    }
    return s;
}
/** Records reachable from no root and no orphan: they sit on a parentUuid cycle, or below one. */
function cycleRecords(t) {
    const seen = new Set(), stack = [...t.roots, ...t.orphans];
    while (stack.length) {
        const n = stack.pop();
        if (seen.has(n))
            continue;
        seen.add(n);
        for (const c of n.children)
            stack.push(c);
    }
    return t.nodes.size - seen.size;
}
/** Why a file that parsed still has nothing to show, so a zero never reads as a clean result. */
function warningsFor(cmd, file, t, lineCount) {
    const warnings = [];
    const consequence = cmd === 'stats' ? 'its counts are 0' : 'it adds no lines';
    const p = t.problems.length;
    if (p)
        warnings.push(`memobrain ${cmd}: warning: '${file}': ${p} line${p === 1 ? '' : 's'} could not be read as a JSON object (first: line ${t.problems[0].line}) and ${p === 1 ? 'was' : 'were'} skipped.`);
    if (t.fileKind === 'empty')
        warnings.push(`memobrain ${cmd}: warning: '${file}' holds no records, so ${consequence}.`);
    else if (t.fileKind === 'journal')
        warnings.push(`memobrain ${cmd}: warning: '${file}' is a workflow journal (launched, started and result records only), not a conversation, so ${consequence}.`);
    else if (t.fileKind === 'unknown') {
        const types = [...new Set(t.records.map((r) => (r.type === undefined || r.type === null ? '(none)' : label(r.type, '(none)'))))].sort();
        const shown = types.slice(0, 6).join(', ') + (types.length > 6 ? `, and ${types.length - 6} more` : '');
        warnings.push(`memobrain ${cmd}: warning: '${file}' has no conversation records (no record carries both uuid and parentUuid; record types found: ${shown}), so ${consequence}. Conversation transcripts are the <session>.jsonl files in ~/.claude/projects/<project>/ and the agent-<id>.jsonl files under <session>/subagents/.`);
    }
    else if (lineCount === 0)
        warnings.push(`memobrain ${cmd}: warning: '${file}' has conversation records but no turn on its live path, so ${consequence}.`);
    const c = t.fileKind === 'transcript' ? cycleRecords(t) : 0;
    if (c)
        warnings.push(`memobrain ${cmd}: warning: '${file}': ${c} record${c === 1 ? '' : 's'} sit${c === 1 ? 's' : ''} on a parentUuid cycle or below one (following the parent links never reaches the start of the session), so the live path through ${c === 1 ? 'it' : 'them'} may be incomplete.`);
    return warnings;
}
function cannotRead(cmd, file, e) {
    const code = e?.code;
    if (code === 'ENOENT')
        return `memobrain ${cmd}: cannot read '${file}': no such file or directory. Check the path. ${TRANSCRIPTS_HINT}`;
    if (code === 'EISDIR')
        return `memobrain ${cmd}: '${file}' is a directory. Pass the .jsonl files inside it, e.g. memobrain ${cmd} ${file.replace(/\/+$/, '')}/*.jsonl`;
    if (code === 'EACCES' || code === 'EPERM')
        return `memobrain ${cmd}: cannot read '${file}': permission denied. Check its permissions with: ls -l '${file}'`;
    if (code === 'ERR_STRING_TOO_LONG')
        return `memobrain ${cmd}: cannot read '${file}': the file is too large to load as one string (the limit is about 512 MB).`;
    return `memobrain ${cmd}: cannot read '${file}': ${e?.message ?? String(e)}`;
}
function readVersion() {
    return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
}
const out = (s) => { if (s)
    process.stdout.write(s); };
const err = (s) => { process.stderr.write(s.endsWith('\n') ? s : s + '\n'); };
function main(argv) {
    const cmd = argv[0];
    if (cmd === undefined) {
        err(`memobrain: no command given.\n\n${USAGE}`);
        return 2;
    }
    if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
        out(HELP);
        return 0;
    }
    if (cmd === '--version' || cmd === '-v') {
        try {
            out(readVersion() + '\n');
            return 0;
        }
        catch (e) {
            err(`memobrain: cannot read the version from package.json next to this program: ${e?.message ?? String(e)}`);
            return 1;
        }
    }
    if (cmd !== 'skeleton' && cmd !== 'stats') {
        if (cmd.startsWith('-'))
            err(`memobrain: unknown option '${cmd}'. The options are --help and --version.\n\n${USAGE}`);
        else
            err(`memobrain: unknown command '${cmd}'. The commands are skeleton and stats.\n\n${USAGE}`);
        return 2;
    }
    const files = [];
    let optionsEnded = false;
    for (const a of argv.slice(1)) {
        if (!optionsEnded && a === '--') {
            optionsEnded = true;
            continue;
        }
        if (!optionsEnded && (a === '--help' || a === '-h')) {
            out(HELP);
            return 0;
        }
        if (!optionsEnded && a === '-') {
            err(`memobrain ${cmd}: reading from standard input ('-') is not supported. Pass the transcript's path, e.g. memobrain ${cmd} ~/.claude/projects/<project>/<session>.jsonl`);
            return 2;
        }
        if (!optionsEnded && a.startsWith('-')) {
            err(`memobrain ${cmd}: unknown option '${a}'. ${cmd} takes file names only; put -- before a file name that starts with '-'.`);
            return 2;
        }
        files.push(a);
    }
    if (!files.length) {
        err(`memobrain ${cmd}: no input files. Pass one or more transcripts, e.g. memobrain ${cmd} ~/.claude/projects/<project>/<session>.jsonl`);
        return 2;
    }
    let failed = 0;
    for (const file of files) {
        let text;
        try {
            text = readFileSync(file, 'utf8');
        }
        catch (e) {
            err(cannotRead(cmd, file, e));
            failed++;
            continue;
        }
        try {
            const t = parseTranscript(text);
            const lines = skeletonOf(file, t);
            for (const w of warningsFor(cmd, file, t, lines.length))
                err(w);
            out(cmd === 'skeleton' ? lines.map((l) => JSON.stringify(l) + '\n').join('') : JSON.stringify(statsOf(file, lines)) + '\n');
        }
        catch (e) {
            err(`memobrain ${cmd}: '${file}': stopped with an internal error, so nothing was written for it: ${e?.message ?? String(e)}. This is a bug in memobrain; the other files are processed as usual.`);
            failed++;
        }
    }
    if (failed) {
        err(`memobrain ${cmd}: ${files.length - failed} of ${files.length} files done; ${failed} failed, as reported above.`);
        return 1;
    }
    return 0;
}
// A reader that stops early (e.g. `| head`) closes the pipe: stop quietly, it is not an error here.
process.stdout.on('error', (e) => {
    if (e.code === 'EPIPE')
        process.exit(process.exitCode ?? 0);
    process.stderr.write(`memobrain: cannot write the output (${e.code ?? e.message}); what was written so far is incomplete.\n`);
    process.exit(1);
});
process.exitCode = main(process.argv.slice(2));
