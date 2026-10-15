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

It follows each session's live path: the branch the session ended on, joined
across compactions and late-written error records. Every payload is replaced
by an address (<first 8 chars of the file name>:L<line number>) and a hash.

skeleton, one line per turn:
  k             "turn"
  a             address of the prompt
  ta            turn id: <first 8 chars of the file name>:T001, T002, ...
  ch            channel the prompt came through: typed, sdk, input, task,
                loop, parent, or the record's own word for another agent
  n             length of the prompt text (JavaScript string length)

skeleton, one line per tool call, after the turn it belongs to:
  k             "call"
  a             address of the tool call
  ta            the turn it belongs to
  tool          tool name
  verb          Bash: the command's first word; Read, Edit, Write: the file's
                extension (its name when it has none); Agent, Task: the
                subagent type; Skill: the skill name; other tools: the name
  in            sha256 of the input as JSON (a missing input counts as {}),
                first 12 hex characters
  ok            false when the call failed
  ek            error class, only when the call failed: hook-block:<hook
                script name>, hook-block, no-anchor, not-read, exit-<code>,
                bad-input, denied, other
  r             address of the result, or null when none was recorded
  out           sha256 of the result text, first 12 hex characters
  n             length of the result text (JavaScript string length)

stats, one line per file:
  session       first 8 characters of the file name
  turns         turns on the live path
  prompts       turns opened by a prompt (channel typed, sdk or input)
  calls         tool calls
  failures      tool calls that failed
  errorClasses  failures by error class
  retries       calls right after a failure, with the same tool
  detours       calls right after a failure, with a different tool
  maxHops       the longest chain of failures with one verb that a later
                success with that verb closed in the same turn, counting
                the success
  hopsOver2     chains of more than 2 hops

Warnings go to stderr: lines that are not JSON objects, and files with nothing
to show (empty, a workflow journal, no conversation records, no turns), so a
zero never reads as a clean result.

Exit status: 0 when every file was processed, 1 when a file could not be read
or processed, 2 on a usage error.
`;
const TRANSCRIPTS_HINT = 'Claude Code keeps transcripts in ~/.claude/projects/<project>/<session>.jsonl.';
const h12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);
const pad3 = (n) => String(n).padStart(3, '0');
/** A short label for what a call did, read from its input; the input itself is never printed.
 *  Bash: the command's first word, after any `cd ... &&`, `VAR=...`, `timeout N`, `nice N`, `env`,
 *  `time`, `command`, `exec` and `nohup`. Read, Edit, Write, NotebookEdit: the file's extension, or
 *  its name when it has none. Agent, Task: the subagent type. Skill: the skill. Else the tool's name. */
function verbOf(tool, input) {
    const inp = input ?? {};
    if (tool === 'Bash') {
        let c = String(inp.command || '').trim().replace(/^(?:cd\s+[^;&|]+&&\s*)+/, '');
        for (let m; (m = /^(?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|\S*)\s+|(?:timeout|nice)\s+-?\S+\s+|(?:env|time|command|exec|nohup)\s+)/.exec(c));)
            c = c.slice(m[0].length);
        const w = (/^[^\s;&|()<>]+/.exec(c) || [''])[0];
        return w ? basename(w) : '(empty)';
    }
    if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool)) {
        const p = String(inp.file_path || inp.notebook_path || '');
        return extname(p) || basename(p) || '(none)';
    }
    if (tool === 'Agent' || tool === 'Task')
        return inp.subagent_type || 'agent';
    if (tool === 'Skill')
        return inp.skill || 'skill';
    return tool;
}
/** A failed call's error CLASS, by fixed rules over the result text: a label, never the text.
 *  A hook block carries the hook script's name (without its extension): a label, not payload. */
function errorClass(text) {
    const first = text.split('\n').find((l) => l.trim()) || '';
    if (/^PreToolUse:|hook error|blocked by .*hook/i.test(first)) {
        const h = /\[(?:bash |node |python3 )?[^\]]*?([\w.-]+)\.(?:sh|mjs|js|py)\b/.exec(first);
        return h ? `hook-block:${h[1]}` : 'hook-block';
    }
    if (/String to replace not found/.test(text))
        return 'no-anchor';
    if (/has not been read yet|must (?:first )?read/i.test(text))
        return 'not-read';
    const ex = /Exit code (\d+)/.exec(text);
    if (ex)
        return `exit-${ex[1]}`;
    if (/InputValidationError|invalid input/i.test(first))
        return 'bad-input';
    if (/denied|not permitted|permission/i.test(first))
        return 'denied';
    return 'other';
}
/** Content as one string: a string as it is; an array of blocks as their texts joined by newlines. */
const flat = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('\n') : '');
const promptLen = (rec) => flat(rec?.message?.content).length;
/** One line per input turn and per tool call on the live path, in path order. */
function skeletonOf(file, t) {
    const sid8 = basename(file).slice(0, 8);
    const at = (n) => `${sid8}:L${t.positions[n.index].line}`;
    const turns = turnsOf(t, repairedLivePath(t).path);
    const lines = [];
    for (let i = 0; i < turns.length; i++) {
        const turn = turns[i], ta = `${sid8}:T${pad3(i + 1)}`;
        lines.push({ k: 'turn', a: at(turn.prompt), ta, ch: inputChannel(turn.prompt.record) ?? 'none', n: promptLen(turn.prompt.record) });
        for (const c of turn.toolCalls) {
            const rt = flat(c.resultBlock?.content);
            lines.push({ k: 'call', a: at(c.callNode), ta, tool: c.name, verb: verbOf(c.name, c.input),
                in: h12(JSON.stringify(c.input ?? {})), ok: !c.isError, ek: c.isError ? errorClass(rt) : undefined,
                r: c.resultNode ? at(c.resultNode) : null, out: h12(rt), n: rt.length });
        }
    }
    return lines;
}
/** The skeleton's shapes, counted: what follows a failed call, and how many calls a chain of
 *  failures with one verb took to come good. Chains are counted within a turn. */
function statsOf(file, lines) {
    const s = { session: basename(file).slice(0, 8), turns: 0, prompts: 0, calls: 0, failures: 0, errorClasses: {}, retries: 0, detours: 0, maxHops: 0, hopsOver2: 0 };
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
        if (!r.ok) {
            const ek = r.ek ?? 'other';
            s.failures++;
            s.errorClasses[ek] = (s.errorClasses[ek] || 0) + 1;
        }
        if (prev && !prev.ok) {
            if (r.tool === prev.tool)
                s.retries++;
            else
                s.detours++;
        }
        if (!r.ok) {
            run = r.verb === runVerb ? run + 1 : 1;
            runVerb = r.verb;
        }
        else if (r.verb === runVerb && run) {
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
        warnings.push(`memobrain ${cmd}: warning: '${file}' is a workflow journal (started and result records only), not a conversation, so ${consequence}.`);
    else if (t.fileKind === 'unknown') {
        const types = [...new Set(t.records.map((r) => (typeof r.type === 'string' ? r.type : '(none)')))].sort();
        const shown = types.slice(0, 6).join(', ') + (types.length > 6 ? `, and ${types.length - 6} more` : '');
        warnings.push(`memobrain ${cmd}: warning: '${file}' has no conversation records (no record carries both uuid and parentUuid; record types found: ${shown}), so ${consequence}. Conversation transcripts are the <session>.jsonl files in ~/.claude/projects/<project>/ and the agent-<id>.jsonl files under <session>/subagents/.`);
    }
    else if (lineCount === 0)
        warnings.push(`memobrain ${cmd}: warning: '${file}' has conversation records but no turn on its live path, so ${consequence}.`);
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
    throw e;
});
process.exitCode = main(process.argv.slice(2));
