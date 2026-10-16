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
last record written), joined across compactions and late-written error
records. Every payload is replaced by an address and a hash. An address is
<prefix>:L<line number>: the prefix is the file name's first 8 characters, or,
for a subagent's agent-<id>.jsonl, agent- and the id's first 8.

skeleton, one line per turn:
  k             "turn"
  a             address of the prompt
  ta            turn id: <prefix>:T001, T002, ...
  ch            channel the prompt came through: typed, sdk, input, task,
                loop, parent, or the record's own word for another agent
                (for example peer)
  n             length of the prompt text (JavaScript string length: UTF-16
                code units)

skeleton, one line per tool call, after the turn it belongs to:
  k             "call"
  a             address of the tool call
  ta            the turn it belongs to
  tool          tool name
  verb          a short label for what the call did. Bash: the program the
                command runs, by a whitelist: printed only when it is a plain
                word (letters, digits and . _ / : , + % @ = ~ ^ -) and every
                word before it can be passed over with certainty: blank and
                comment lines; cd DIR (with redirections) followed by && ; or
                a newline; NAME=value with a plain, '...', simple "..." or
                $NAME value; an opening ( { or !; the wrappers nohup, command,
                exec, time (-p), env (-i, NAME=value), timeout (a duration)
                and nice (-n N). A path is cut to its last part; a command
                that only assigns values is labelled by the program inside
                its first $(...) when that is made of such words; a wrapper
                with nothing after it is the program; [ [[ and shell keywords
                print as themselves. Anything else before the program, a
                program that is not a plain word, or a function definition
                gives (withheld). Read, Edit, Write, NotebookEdit: the file's
                extension (its name when it has none). Agent, Task: the
                subagent type. Skill: the skill name. Other tools: the name
  in            sha256 of the input as JSON.stringify writes it (a missing
                input counts as {}), first 12 hex characters; (too deep) when
                it is nested too deeply to serialize
  ok            true when the call succeeded, false when it failed, null when
                no result was recorded (the session ended, or the file was
                cut, before the call returned)
  ek            error class, only when the call failed, from the result's
                first line: exit-<code> (a leading "Exit code N", read
                first), hook-block:<hook script name> or hook-block (Claude
                Code's own format only: PreToolUse:<tool> hook error:
                [<command>]; the name is the first word in the brackets with
                a script extension), no-anchor, not-read, bad-input, denied,
                other
  r             address of the result, or null when none was recorded
  out           sha256 of the result text (UTF-8), first 12 hex characters;
                of the whole result as JSON when it holds anything but text;
                (too deep) when that is nested too deeply to serialize; null
                when no result was recorded
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
show (empty, a workflow journal, no conversation records, no turns), records
whose parent links loop, and values nested too deeply to hash, so a zero never
reads as a clean result.

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
// A WHITELIST, not a model of bash. The PROGRAM is printed only when it is a plain word: letters, digits and
// . _ / : , + % @ = ~ ^ - and nothing else. The words before it are passed over only when each is PASSABLE: made of
// plain parts (and the glob characters * and ?), '...' (literal in bash), "..." holding no \, `, " or $ other than $NAME, ${NAME} or $0-$9, and those
// expansions bare. Where such a word ends is certain, so bash's reading and this one cannot differ about which word
// is the program, and nothing the shell would treat as data can be taken for it. Two reviews of an earlier lexer
// that modelled quotes, substitutions, here-documents and comments in full found payload printed through each part
// it modelled wrong; a whitelist has no such parts. Passed over before the program: blank and comment lines;
// `cd DIR` (with redirections) followed by `&&`, `;` or a new line; NAME=value assignments; an opening `(`, `{` or
// `!`; and the wrappers below. Anything else met before the program withholds the verb. What follows the program
// is never read.
/** A word bash reads as exactly its own text. */
const PLAIN = /[A-Za-z0-9_.\/:,+%@=~^-]+/y;
/** One part of a passable word. */
const PART = /[A-Za-z0-9_.\/:,+%@=~^*?-]+|'[^']*'|"(?:[^"\\$`]|\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\}|\d))*"|\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\}|\d)/y;
const NAME_EQ = /[A-Za-z_]\w*\+?=/y;
/** A redirection cd may carry before its separator: N>file, N>>file, <file, &>file, N>&M, N>&-. */
const REDIR = /\d*[<>]&(?:\d+|-)(?=[ \t\n;&|]|$)|(?:\d*(?:>>|>|<)|&>>?)(?!\()[ \t]*/y;
/** What may be inside a $(...) that is read: plain parts, blanks, ; & | < > and new lines, '...', safe "...", $NAME. */
const INNER = /(?:[A-Za-z0-9_.\/:,+%@=~^*? \t\n;&|<>-]|'[^']*'|"(?:[^"\\$`]|\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\}|\d))*"|\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\}|\d))*\)/y;
/** Wrappers that run the program after them. The words each takes before it: nothing (nohup, command, exec), -p
 *  (time), -i and NAME=value (env), a duration (timeout), -n N or -N (nice). Any other option withholds the verb, and so
 *  does a NAME=value after any wrapper but env: there it is the program's name, not an assignment. time is the
 *  keyword only where a command starts; elsewhere it is a program of its own. (builtin is not a wrapper here: what
 *  follows it names a builtin, or an error.) */
const WRAPPERS = new Set(['time', 'nohup', 'env', 'command', 'exec', 'timeout', 'nice']);
/** Bash: the program in command position, by the whitelist above. A path prints its last segment; [ and [[ print
 *  as themselves, and so does a shell keyword (if, for, while, ...): neither carries payload. A command whose only
 *  words are assignments prints (empty), or, when the first assignment's value is a substitution $(...) or
 *  "$(...)" made only of what INNER allows, the program inside it. A function definition is withheld. */
function bashVerb(s, depth = 0) {
    let i = 0, words = 0, sub;
    const blank = (nl = false) => { while (s[i] === ' ' || s[i] === '\t' || (nl && s[i] === '\n'))
        i++; };
    const ends = (j) => j >= s.length || ' \t\n;&|<>)'.includes(s[j]);
    const at = (re, k) => { re.lastIndex = k; const m = re.exec(s); return m ? m[0] : null; };
    /** The end of a passable word starting at k (possibly empty), or -1. */
    const passable = (k) => {
        let j = k;
        for (let p = at(PART, j); p !== null && p.length; p = at(PART, j))
            j += p.length;
        return ends(j) ? j : -1;
    };
    const separator = () => (s.startsWith('&&', i) ? 2 : s[i] === ';' || s[i] === '\n' ? 1 : 0);
    for (let cmd = 0; cmd < 16; cmd++) { // simple commands passed over: cd DIR, assignments only
        for (;;) { // blank and comment lines; a command may open with ( { or !
            blank(true);
            if (s[i] === '#') {
                while (i < s.length && s[i] !== '\n')
                    i++;
                continue;
            }
            if (s[i] === '(' && s[i + 1] !== '(') {
                i++;
                continue;
            }
            if ((s[i] === '{' || s[i] === '!') && (s[i + 1] === ' ' || s[i + 1] === '\t' || s[i + 1] === '\n')) {
                i++;
                continue;
            }
            break;
        }
        let first = true, next = false, wrapped = false;
        while (!next) {
            if (i >= s.length)
                return sub ?? '(empty)';
            if (++words > 64)
                return WITHHELD;
            const name = at(NAME_EQ, i);
            if (name !== null) { // NAME=value
                if (wrapped)
                    return WITHHELD; // after a wrapper it is the program's name
                let j = i + name.length;
                if (s.startsWith('$(', j) || s.startsWith('"$(', j)) { // NAME=$(...) or NAME="$(...)"
                    const q = s[j] === '"' ? 1 : 0, open = j + q + 2;
                    const inner = depth < 3 && s[open] !== '(' ? at(INNER, open) : null;
                    // a here-document's body or a case pattern can hold a ')' that closes nothing: refused, not modelled
                    if (inner === null || (q && s[open + inner.length] !== '"') || /<<|(?:^|[\s;&|])case\s/.test(inner))
                        return WITHHELD;
                    sub ??= bashVerb(s.slice(open, open + inner.length - 1), depth + 1);
                    j = open + inner.length + q;
                    if (!ends(j))
                        return WITHHELD;
                }
                else {
                    j = passable(j);
                    if (j < 0)
                        return WITHHELD;
                }
                i = j;
                blank();
                first = false;
                const sep = separator();
                if (sep) {
                    i += sep;
                    next = true;
                }
                else if (i >= s.length)
                    return sub ?? '(empty)';
                continue;
            }
            const x = at(PLAIN, i);
            if (x === null) {
                if (s.startsWith('[[', i) && ends(i + 2))
                    return '[[';
                if (s[i] === '[' && ends(i + 1))
                    return '[';
                return WITHHELD;
            }
            const j = i + x.length;
            if (!ends(j))
                return WITHHELD; // the word goes on in a way this does not read
            i = j;
            blank();
            if (x === 'cd' && first) { // cd DIR && ...: the program is the next one's
                const d = passable(i);
                if (d > i) {
                    i = d;
                    blank();
                }
                for (let r = at(REDIR, i); r !== null; r = at(REDIR, i)) {
                    i += r.length;
                    if (!/&(?:\d+|-)$/.test(r)) {
                        const t = passable(i);
                        if (t <= i)
                            return 'cd';
                        i = t;
                    }
                    blank();
                }
                const sep = separator();
                if (!sep)
                    return 'cd';
                i += sep;
                next = true;
                continue;
            }
            if (WRAPPERS.has(x) && (x !== 'time' || first)) { // time is the keyword only where a command starts
                first = false;
                wrapped = true;
                if (x === 'time' && s.startsWith('-p', i) && ends(i + 2)) {
                    i += 2;
                    blank();
                }
                if (x === 'timeout') {
                    const d = at(/\d+(?:\.\d+)?[smhd]?/y, i);
                    if (d === null || !ends(i + d.length))
                        return i >= s.length || separator() ? x : WITHHELD;
                    i += d.length;
                    blank();
                }
                if (x === 'nice') {
                    const d = at(/(?:-n[ \t]+-?\d+|-\d+)(?=[ \t])/y, i);
                    if (d !== null) {
                        i += d.length;
                        blank();
                    }
                }
                if (x === 'env') {
                    if (s.startsWith('-i', i) && ends(i + 2)) {
                        i += 2;
                        blank();
                    }
                    for (let a = at(NAME_EQ, i); a !== null; a = at(NAME_EQ, i)) {
                        const e = passable(i + a.length);
                        if (e < 0)
                            return WITHHELD;
                        i = e;
                        blank();
                    }
                }
                if (i >= s.length || separator() || '|&<>)'.includes(s[i]))
                    return x; // the wrapper alone: `env | grep x`
                if (s[i] === '-')
                    return WITHHELD; // an option it does not read
                continue;
            }
            if (x === 'function' || (/^\d+$/.test(x) && (s[j] === '<' || s[j] === '>')))
                return WITHHELD; // a definition; an fd
            if (/^\(\s*\)/.test(s.slice(i, i + 64)))
                return WITHHELD; // NAME () { ...: a definition
            return label(x.slice(x.lastIndexOf('/') + 1), WITHHELD);
        }
    }
    return WITHHELD;
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
/** A failed call's error CLASS, by fixed rules over the result's FIRST line: a label, never the text. A hook block
 *  is recognised only in the harness's own format (PreToolUse:<tool> hook error: [<command>]: ...); the hook's name
 *  is the first word inside those brackets that ends in a script extension (.sh .py .js ...), cut at the extension,
 *  and it passes the label rule or the class is plain hook-block. An exit code is read only from a leading
 *  "Exit code N", before anything else, so a command's own output cannot change its class. */
function errorClass(text) {
    const first = (text.split('\n').find((l) => l.trim()) || '').slice(0, 400);
    const hook = /^PreToolUse:[\w.:-]* hook error: \[([^\]]{0,300})\]/.exec(first);
    if (hook) {
        const script = hook[1].trim().split(/\s+/).map((w) => /(?:^|[\\/])([\w.-]+)\.(?:sh|bash|mjs|cjs|js|ts|py|rb|pl)$/.exec(w)).find(Boolean);
        return script && FILE_LABEL.test(script[1]) && script[1].length <= 48 ? `hook-block:${script[1]}` : 'hook-block';
    }
    const ex = /^\s*Exit code (\d{1,3})\b/.exec(first);
    if (ex)
        return `exit-${ex[1]}`;
    if (/String to replace not found/.test(first))
        return 'no-anchor';
    if (/has not been read yet|must (?:first )?read/i.test(first))
        return 'not-read';
    if (/InputValidationError|invalid input/i.test(first))
        return 'bad-input';
    if (/denied|not permitted|permission/i.test(first))
        return 'denied';
    return 'other';
}
/** Content as one string: a string as it is; an array as its text blocks (and bare strings) joined by newlines. */
const flat = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : typeof x?.text === 'string' ? x.text : '')).join('\n') : '');
/** A value nested too deeply to serialize (a crafted file; Node 20 overflows its stack near 5,000 levels) gets this
 *  in place of a hash, and a warning; the rest of the file is still read. */
const TOO_DEEP = '(too deep)';
const jsonHash = (v) => {
    try {
        return h12(JSON.stringify(v) ?? '');
    }
    catch (e) {
        if (e instanceof RangeError)
            return TOO_DEEP;
        throw e;
    }
};
/** What a result's hash covers: its text, or, when it holds anything else (an image), the whole content as JSON. */
const outHash = (c) => (Array.isArray(c) && c.some((x) => isRecord(x) && x.type !== 'text') ? jsonHash(c) : h12(flat(c)));
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
                in: jsonHash(c.input ?? {}), ok: answered ? !c.isError : null, ek: answered && c.isError ? errorClass(rt) : undefined,
                r: c.resultNode ? at(c.resultNode) : null, out: answered ? outHash(c.resultBlock?.content) : null, n: answered ? rt.length : null });
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
function warningsFor(cmd, file, t, lines) {
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
    else if (lines.length === 0)
        warnings.push(`memobrain ${cmd}: warning: '${file}' has conversation records but no turn on its live path, so ${consequence}.`);
    const deep = lines.filter((l) => l.k === 'call' && (l.in === TOO_DEEP || l.out === TOO_DEEP)).length;
    if (deep)
        warnings.push(`memobrain ${cmd}: warning: '${file}': ${deep} call${deep === 1 ? '' : 's'} hold a value nested too deeply to hash; ${deep === 1 ? 'its' : 'their'} in or out field reads ${TOO_DEEP}.`);
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
            for (const w of warningsFor(cmd, file, t, lines))
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
