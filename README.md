# memobrain

When a Claude Code session fills its context window, or on `/compact`, Claude Code compacts it: the conversation in the model's context is replaced by a summary, and the model carries on from the summary. The details, such as which commands ran, which of them failed and which files were read or changed, are no longer in front of the model. They are still on disk. Claude Code only ever appends to a session's transcript, the `.jsonl` file under `~/.claude/projects/`: a compaction adds a boundary record and the summary, and every record before them stays where it was. The summary itself names the file.

memobrain reads that transcript, across its compactions, and prints an index of it without its content: one JSON line per turn and per tool call. A turn's line gives the address of its prompt, the line of the file where it is written. A tool call's line gives the addresses of the call and of its result, and hashes of what went in and what came out. On the transcripts it was tested on, the index is about 0.5 % of the file's size, so it fits in a context window where the transcript does not, and every address leads back to the line to read.

## Install

Needs Node.js 20 or newer. No dependencies.

```sh
npx memobrain stats ~/.claude/projects/<project>/<session>.jsonl
```

Or install it once: `npm install -g memobrain`.

## Commands

### `memobrain skeleton <file.jsonl>...`

One JSON line per turn and per tool call. A turn starts at a prompt; its tool calls follow it in order. This is one turn of the synthetic test transcript [`test/fixtures/demo.jsonl`](https://github.com/memobrain-app/memobrain/blob/main/test/fixtures/demo.jsonl): a hook blocks a command, the tests fail twice, a fix is made, the tests pass.

```
{"k":"turn","a":"demo.jso:L20","ta":"demo.jso:T003","ch":"typed","n":47}
{"k":"call","a":"demo.jso:L22","ta":"demo.jso:T003","tool":"Bash","verb":"rm","in":"8672006e23d8","ok":false,"ek":"hook-block:demo-gate","r":"demo.jso:L23","out":"f69cbd101377","n":111}
{"k":"call","a":"demo.jso:L24","ta":"demo.jso:T003","tool":"Bash","verb":"npm","in":"84c7c646123a","ok":false,"ek":"exit-1","r":"demo.jso:L25","out":"429ad9a9f725","n":58}
{"k":"call","a":"demo.jso:L26","ta":"demo.jso:T003","tool":"Bash","verb":"npm","in":"d990b201195a","ok":false,"ek":"exit-1","r":"demo.jso:L27","out":"3953f9b8b91c","n":69}
{"k":"call","a":"demo.jso:L28","ta":"demo.jso:T003","tool":"Edit","verb":".js","in":"42eb1ba06a92","ok":true,"r":"demo.jso:L29","out":"99a70feb06ce","n":56}
{"k":"call","a":"demo.jso:L30","ta":"demo.jso:T003","tool":"Bash","verb":"npm","in":"5d0af2eddc4d","ok":true,"r":"demo.jso:L31","out":"12112eacc5de","n":35}
```

An address such as `demo.jso:L22` means line 22 of the file whose name starts with `demo.jso`. Claude Code names each transcript after its session id, so for real files the prefix is the first 8 characters of the session id. A subagent's transcript is named `agent-<id>.jsonl`, and those names all start alike, so there the prefix is `agent-` and the id's first 8 characters (`agent-a0123456:L2`). To read what a line hides, open that line of the transcript, for example `sed -n 22p <file.jsonl>`. Two calls made in one record share that record's address; files whose names start with the same 8 characters print the same prefix, so give them to separate runs.

| field | in | meaning |
|---|---|---|
| `k` | both | `"turn"` or `"call"` |
| `a` | both | address of the prompt, or of the tool call |
| `ta` | both | turn id: `<address prefix>:T001`, `T002`, ... |
| `ch` | turn | the channel the prompt came through: `typed`, `sdk`, `input`, `task` (a background task's notification), `loop` (a timer), `parent` (the agent that delegated to this one), or the record's own word for another agent (for example `peer`); `none` when the record names no channel, and `(withheld)` when its word does not pass the label rule |
| `n` | both | length of the prompt text, or of the result text, as JavaScript counts it (UTF-16 code units; a content array's blocks are joined with a new line, and a block that is not text counts as an empty one); `null` on a call whose result was never recorded |
| `tool` | call | tool name |
| `verb` | call | a short label. For Bash, the program the command runs, read by the rule in [The Bash verb](#the-bash-verb) below; `(withheld)` when that rule cannot be sure, and `(empty)` when nothing runs or the call has no command. For Read, Edit, Write and NotebookEdit, the file's extension (its name when it has none; `(none)` when there is no path, or it ends in `/`). For Agent and Task, the subagent type; for Skill, the skill name; for other tools, the tool's name |
| `in` | call | sha256 of the input as JavaScript's `JSON.stringify` writes it (integer-like keys first, the others in the transcript's order; a missing input counts as `{}`), first 12 hex characters; `(too large)` when the input, written as JSON, would pass JavaScript's limit on a string's length (a warning says so) |
| `ok` | call | `true` when the call succeeded; `false` when it failed (its result is marked `is_error`, or Claude Code wrote the error as a string in `toolUseResult`); `null` when no result was recorded (the session ended, or the file was cut, before the call returned) |
| `ek` | call | only on a failed call, its error class, from the result's first line: `exit-<code>` (a leading `Exit code N`, up to 3 digits; read first, so a command's own output cannot change it), `hook-block:<hook script name>` and `hook-block` (only in Claude Code's own format, `PreToolUse:<tool> hook error: [<command>]`; the name is the one word in the brackets that ends in a script extension (`.sh` `.bash` `.py` `.js` `.mjs` `.cjs` `.ts` `.rb` `.pl`, lower case), cut at the extension: none when two or more do, and none when it is longer than 48 characters or fails the label rule; a bracket longer than 300 characters is a plain `hook-block`), `no-anchor` (Edit's text was not found), `not-read`, `bad-input`, `denied`, `other` |
| `r` | call | address of the result, or `null` when none was recorded |
| `out` | call | sha256 of the result text (its UTF-8 bytes; blocks joined as for `n`), first 12 hex characters; of the whole result as JSON when it holds anything but text (an image), with `(too large)` as for `in`; `null` when no result was recorded |

### The Bash verb

The verb is printed only when memobrain can be certain it is the program bash runs. It is a whitelist, not a model of the shell: the program must be a **plain word** (ASCII letters, digits and `. _ / : , + % @ = ~ ^ -`, nothing else), and every word before it must be one memobrain can pass over with certainty:

- blank lines and comment lines;
- `cd DIR`, with redirections such as `2>/dev/null`, followed by `&&`, `;` or a new line (the program is the next command's);
- `NAME=value` assignments whose value is made of plain words, `'...'`, `"..."` holding no `\`, `` ` ``, `"` or `$` other than `$NAME`, `${NAME}` and `$0`–`$9`, those expansions bare, and `*` and `?`;
- an opening `(`, `{` or `!`;
- the wrappers `nohup`, `command`, `exec`, `time` (with `-p`; only where a command starts, since elsewhere `time` is a program of its own), `env` (with `-i` and `NAME=value`, where an unquoted `$NAME` withholds the verb: after `env` it is an argument, and bash splits it), `timeout` (with a duration) and `nice` (with `-n N` or `-N`). After `nohup`, `env`, `nice`, `timeout` or `exec`, which look the next word up as a file, `command` and `exec` are programs of their own; after `command` or `time` they are still the shell's builtins.

A path is cut to its last part. When nothing runs after the words passed over (a command of assignments only, or `cd DIR;` with nothing after it), the verb is `(empty)`; when an assignment's value is a command substitution made of such words, it is the program inside the first such substitution. A wrapper with nothing after it but its own options is the program. The shell's test brackets print as `[` and `[[`, and a shell keyword prints as itself. Anything else before the program (a here-document, another redirection, an option the wrapper list does not name, any other `$(...)` or `${...}`, a backslash, more than 63 words before the program, more than 15 commands passed over), a program that is not a plain word, and a function definition make the verb `(withheld)`. The program then passes the label rule in [Privacy](#privacy), like every label, so a name holding `,` `%` `@` `=` `~` or `^` prints `(withheld)` too. What follows the program is never read.

| command | verb |
|---|---|
| `cd ~/proj && npm test` | `npm` |
| `CI=1 timeout 120 npm test` | `npm` |
| `REV="$(git rev-parse HEAD)"` | `git` |
| `X=$(git log -1 --format='%H') make demo` | `make` |
| `cd "$HOME/my project" 2>/dev/null && make demo` | `make` |
| `env \| grep x` | `env` |
| `for f in *.txt; do wc -l "$f"; done` | `for` |
| `sudo -u demo make install` | `sudo` |
| `X=1 time make demo` | `time` |
| `"$PY" scripts/run.py` | `(withheld)` |
| `$DIR/run.sh --fast` | `(withheld)` |
| `command -v node` | `(withheld)` |
| `nohup X=1 ./job.sh` | `(withheld)` (after a wrapper, `X=1` is the program's name) |
| `command exec make demo` | `make` |
| `nohup command make demo` | `command` |

On the transcripts it was tested on, about 1 Bash call in 100 prints `(withheld)`.

### `memobrain stats <file.jsonl>...`

One JSON line of counts per file. For the same test transcript:

```
{"session":"demo.jso","turns":4,"prompts":3,"calls":12,"failures":5,"unanswered":0,"errorClasses":{"other":1,"no-anchor":1,"hook-block:demo-gate":1,"exit-1":2},"retries":2,"detours":2,"maxHops":3,"hopsOver2":1}
```

| field | meaning |
|---|---|
| `session` | the file's address prefix |
| `turns` | turns on the live path |
| `prompts` | turns opened by a prompt (channel `typed`, `sdk` or `input`); every other channel (task notifications, timers, delegations, another agent's word, `none`, `(withheld)`) is not counted |
| `calls` | tool calls |
| `failures` | tool calls that failed |
| `unanswered` | tool calls whose result was never recorded; they count neither as failures nor as successes |
| `errorClasses` | failures by error class |
| `retries` | calls made right after a failed call in the same turn, with the same tool, and issued after its result (a call sent in the same response as the failed one is not its retry) |
| `detours` | the same, with a different tool |
| `maxHops` | the longest chain of failures with one verb, each issued after the previous one's result, that a later success with the same verb closed in the same turn, counting the success (above: two failed `npm` runs, then a passing one, is 3 hops). A failure with another verb ends a chain and starts a new one, even when it was sent in the same response; a placeholder such as `(withheld)` counts as one verb |
| `hopsOver2` | how many such chains were longer than 2 hops |

`memobrain --help` lists every field; `memobrain --version` prints the version.

## What it reads

- Only the files named on the command line.
- Only the live path of each session: the branch it ended on, as the transcript's own `last-prompt` record names it (a file without one is read along the branch of the last record written). The path is joined across compactions and across API errors that were written after the retry that followed them, and a record whose parent is not in the file is joined to the record written just before it. Branches that were rewound are not shown. Calls made in parallel by one response all belong to their turn, even when their results came back out of order; a response is known by its `requestId`, or by its `message.id` in versions that wrote none, and a response whose records fall in two turns gives its calls to the first.
- Compaction, as measured on Claude Code 2.1.270, 2.1.272 and 2.1.300: the file before a `/compact` is a byte-for-byte prefix of the file after it. The compaction appends a boundary record, which starts a new root and points back to the last record before it, and then the summary. memobrain follows that pointer, so the turns before and after a compaction appear in order.
- The transcript format is internal to Claude Code and changes between versions. Records of a shape memobrain does not know are passed over, not treated as errors.
- A file is read into memory whole: it takes about five to eight times the file's size. For a file over about 200 MB, give Node more memory, for example `NODE_OPTIONS=--max-old-space-size=4096`; a file over about 500 MB cannot be read at all (JavaScript's limit on a string's length).
- A line that is not a JSON object, or that is nested more than 1,000 levels deep, is skipped and reported on stderr. A file with nothing to show (empty, a workflow journal, no conversation records, no turns) is reported too, so a zero never reads as a clean result, and so are records whose parent links loop instead of reaching the start of the session.

Exit status: 0 when every file was processed, 1 when a file could not be read or processed, 2 on a usage error.

## Privacy

- memobrain reads local files only, writes only to stdout and stderr, makes no network connections and collects no telemetry. It has no runtime dependencies.
- The output contains no prompts, replies, tool inputs or tool outputs. It does contain a few short labels derived from them: the program a shell command runs (or a shell keyword), a file's extension (or its name, when it has none), a subagent type, a skill name, a tool's name, the channel a prompt came through, the name of a hook script that blocked a call, an error class, and the lengths of prompts and results.
- A label is printed only when it looks like one: at most 64 ASCII letters, digits and `. _ : + -` (a file's name or extension: without `:`; the shell's `[` and `[[` as they are). Anything else (free text, a quoted or computed command, a value that is not a string) prints as `(withheld)`. The shell command's label is read by the whitelist in [The Bash verb](#the-bash-verb): it is printed only when it and every word before it are words bash reads exactly as written, so an argument, a quoted string or a here-document is never taken for the program. The record types named in a warning pass the same label rule.
- A hash cannot be reversed, but it can confirm a guess: whoever can guess the exact bytes of an input or a result (a short command and its description, a one-line output) can hash the guess and compare. Treat the output as derived from your transcripts.

## Status

Version 0.0.2. Early: the output format may change between versions.

## Development

```sh
npm install      # TypeScript and Node type definitions, for building only
npm run build    # compiles src/ to dist/
npm test         # runs test/cli.test.mjs against dist/cli.js
```

`MEMOBRAIN_HEAVY=1 npm test` also runs a test that writes a file of about 125 MB and needs about 3 GB of memory.

The test transcripts in `test/fixtures/` are synthetic, with invented text: some hand-written, the rest written by `node test/make-fixtures.mjs test/fixtures` (the output is the same on every run).

## License

MIT
