# Changes

## 0.0.2

- The README opens with why memobrain exists: compaction replaces the model's context with a summary, and the transcript on disk keeps every record.
- Output changes, on crafted input only (on 2,513 real transcripts the output did not change):
  - after `command` or `time`, a following `command` or `exec` is the shell's builtin, so the verb is the program after it (`command exec make` prints `make`; it printed `exec`);
  - `nice` with only its options after it prints `nice` (it printed `(withheld)`);
  - `time` right after the `time` keyword is the keyword again (`time time make` prints `make`);
  - a redirection right after a wrapper withholds the verb (`nohup >/dev/null make` printed `nohup`);
  - `env`'s assignments count toward the limit of 63 words before the program;
  - a hook block names its script only when exactly one word ends in a script extension, whatever the other word's characters;
  - a hook block whose bracketed command is longer than 300 characters is a `hook-block` (it was `other`);
  - a value too large to write as JSON prints `(too large)` in `in` and `out`, with a warning, where the file was dropped; three routes in the parser where such a value stopped the file are guarded too (crafted values can still stop a file through others);
  - a prompt's text block that is not a string counts as empty text;
  - the skeleton is written in chunks, so millions of call lines no longer pass JavaScript's string limit;
  - a `toString` or `valueOf` key written with escaped characters no longer stops the file.
- The README and `--help` define every value the output can hold.

## 0.0.1

- First release: `skeleton` and `stats`.
