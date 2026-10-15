# memobrain

memobrain reads Claude Code session transcripts (the `.jsonl` files under `~/.claude/projects/`) and prints their structure without their content. Every turn and every tool call becomes one JSON line in which the payload is replaced by an address (where it lives in the file) and a hash (which bytes were there).

## Install

Needs Node.js 20 or newer. No dependencies.

```sh
npx memobrain stats ~/.claude/projects/<project>/<session>.jsonl
```

Or install it once: `npm install -g memobrain`.

## Commands

### `memobrain skeleton <file.jsonl>...`

One JSON line per turn and per tool call. A turn starts at a prompt; its tool calls follow it in order. This is one turn of the synthetic test transcript [`test/fixtures/demo.jsonl`](test/fixtures/demo.jsonl): a hook blocks a command, the tests fail twice, a fix is made, the tests pass.

```
{"k":"turn","a":"demo.jso:L20","ta":"demo.jso:T003","ch":"typed","n":47}
{"k":"call","a":"demo.jso:L22","ta":"demo.jso:T003","tool":"Bash","verb":"rm","in":"8672006e23d8","ok":false,"ek":"hook-block:demo-gate","r":"demo.jso:L23","out":"f69cbd101377","n":111}
{"k":"call","a":"demo.jso:L24","ta":"demo.jso:T003","tool":"Bash","verb":"npm","in":"84c7c646123a","ok":false,"ek":"exit-1","r":"demo.jso:L25","out":"429ad9a9f725","n":58}
{"k":"call","a":"demo.jso:L26","ta":"demo.jso:T003","tool":"Bash","verb":"npm","in":"d990b201195a","ok":false,"ek":"exit-1","r":"demo.jso:L27","out":"3953f9b8b91c","n":69}
{"k":"call","a":"demo.jso:L28","ta":"demo.jso:T003","tool":"Edit","verb":".js","in":"42eb1ba06a92","ok":true,"r":"demo.jso:L29","out":"99a70feb06ce","n":56}
{"k":"call","a":"demo.jso:L30","ta":"demo.jso:T003","tool":"Bash","verb":"npm","in":"5d0af2eddc4d","ok":true,"r":"demo.jso:L31","out":"12112eacc5de","n":35}
```

An address such as `demo.jso:L22` means line 22 of the file whose name starts with `demo.jso`. Claude Code names each transcript after its session id, so for real files the prefix is the first 8 characters of the session id. To read what a line hides, open that line of the transcript, for example `sed -n 22p <file.jsonl>`.

| field | in | meaning |
|---|---|---|
| `k` | both | `"turn"` or `"call"` |
| `a` | both | address of the prompt, or of the tool call |
| `ta` | both | turn id: `<first 8 chars of the file name>:T001`, `T002`, ... |
| `ch` | turn | the channel the prompt came through: `typed`, `sdk`, `input`, `task` (a background task's notification), `loop` (a timer), `parent` (the agent that delegated to this one) |
| `n` | both | length of the prompt text, or of the result text (JavaScript string length) |
| `tool` | call | tool name |
| `verb` | call | a short label: for Bash the command's first word; for Read, Edit and Write the file's extension (its name when it has none); for Agent and Task the subagent type; for Skill the skill name; for other tools the tool's name |
| `in` | call | sha256 of the input as JSON (a missing input counts as `{}`), first 12 hex characters |
| `ok` | call | `false` when the call failed |
| `ek` | call | only on a failed call, its error class: `hook-block:<hook script name>`, `hook-block`, `no-anchor` (Edit's text was not found), `not-read`, `exit-<code>`, `bad-input`, `denied`, `other` |
| `r` | call | address of the result, or `null` when none was recorded |
| `out` | call | sha256 of the result text, first 12 hex characters |

### `memobrain stats <file.jsonl>...`

One JSON line of counts per file. For the same test transcript:

```
{"session":"demo.jso","turns":4,"prompts":3,"calls":12,"failures":5,"errorClasses":{"other":1,"no-anchor":1,"hook-block:demo-gate":1,"exit-1":2},"retries":2,"detours":2,"maxHops":3,"hopsOver2":1}
```

| field | meaning |
|---|---|
| `session` | first 8 characters of the file name |
| `turns` | turns on the live path |
| `prompts` | turns opened by a prompt (channel `typed`, `sdk` or `input`); task notifications, timers and delegations are not counted |
| `calls` | tool calls |
| `failures` | tool calls that failed |
| `errorClasses` | failures by error class |
| `retries` | calls made right after a failure, with the same tool |
| `detours` | calls made right after a failure, with a different tool |
| `maxHops` | the longest chain of failures with one verb that a later success with the same verb closed in the same turn, counting the success (above: two failed `npm` runs, then a passing one, is 3 hops) |
| `hopsOver2` | how many such chains were longer than 2 hops |

`memobrain --help` lists every field; `memobrain --version` prints the version.

## What it reads

- Only the files named on the command line.
- Only the live path of each session: the branch it ended on, as the transcript's own `last-prompt` record names it. The path is joined across compactions and across API errors that were written after the retry that followed them. Branches that were rewound are not shown.
- The transcript format is internal to Claude Code and changes between versions. Records of a shape memobrain does not know are passed over, not treated as errors.
- A line that is not a JSON object is skipped and reported on stderr. A file with nothing to show (empty, a workflow journal, no conversation records, no turns) is reported too, so a zero never reads as a clean result.

Exit status: 0 when every file was processed, 1 when a file could not be read or processed, 2 on a usage error.

## Privacy

- memobrain reads local files only, writes only to stdout and stderr, makes no network connections and collects no telemetry. It has no runtime dependencies.
- The output contains no prompts, replies, tool inputs or tool outputs. It does contain a few short labels derived from them: a shell command's first word, a file's extension (or its name, when it has none), a subagent type, a skill name, the name of a hook script that blocked a call, and the lengths of prompts and results.
- A hash cannot be reversed, but it can confirm a guess: whoever can guess the exact bytes of an input or a result (a short command and its description, a one-line output) can hash the guess and compare. Treat the output as derived from your transcripts.

## Status

Version 0.0.1. Early: the output format may change between versions.

## Development

```sh
npm install      # TypeScript and Node type definitions, for building only
npm run build    # compiles src/ to dist/
npm test         # runs test/cli.test.mjs against dist/cli.js
```

The test transcripts in `test/fixtures/` are synthetic: hand-written records with invented text.

## License

MIT
