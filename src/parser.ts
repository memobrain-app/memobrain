// ============================================================================
//  parser.ts: a structure-preserving parser for Claude Code transcript JSONL.
//
//  Plain TypeScript with no dependencies and no Node imports, so it runs
//  unchanged in Node and in a browser.
//
//  ---- WHAT THIS IS ----------------------------------------------------------
//  A transcript is written for STREAMING: one JSON object per line, appended as
//  events occur. That is the right shape for a writer and the wrong shape for a
//  reader. What is actually recorded is a TREE: every conversational record
//  carries `parentUuid`, and the conversation as it happened is one PATH
//  through that tree. This file turns the stream back into the tree without
//  discarding anything: unknown record types, unknown vocabulary values, and
//  even unparseable lines come back as data you can look at.
//
//  A node with several children is usually NOT a rewind or an edited prompt.
//  Most such forks are CONCURRENCY: one API response with several tool_use
//  blocks, where each block is its own record and each tool_result hangs off
//  its own call. Fewer are api_error retries, or hook records racing a result
//  onto one parent. A real rewind (two prompts under one parent) is rare.
//
//  ---- THE FORMAT IS INTERNAL AND VERSION-DEPENDENT --------------------------
//  Claude Code's documentation describes the entry format as internal to
//  Claude Code: it changes between versions, and scripts that parse the files
//  directly can break on any release. Fields come and go (a top-level
//  `session_id`, for example, appeared in a single version and never again).
//  So this parser never requires a field it does not have, never switches
//  exhaustively on a vocabulary, and never throws on an unknown shape.
//  Unknown is a RESULT, not an error.
//
//  ---- FIVE TRAPS THIS FILE AVOIDS -------------------------------------------
//  1. An `assistant` record is ONE CONTENT BLOCK, not a message. One API
//     response is written as several assistant records, so treating a record
//     as a turn overcounts by roughly 2-3x. Group by `requestId`; order by
//     `apiBlockIndex` where it exists.
//  2. A tool RESULT is a `type:"user"` record. In a working session the
//     tool-result records far outnumber the prompts a person typed. The
//     discriminator is the CONTENT SHAPE, never the type field.
//  3. `usage` is repeated on every record of one request. Summing it per
//     record overcounts tokens (by more than 2x in practice). Charge it ONCE
//     per `message.id`.
//  4. `toolUseResult` (top level, undocumented) and the `tool_result` content
//     block are TWO RECORDINGS OF ONE EVENT at different fidelity. The block
//     holds a flattened string; `toolUseResult` holds the structure: stdout
//     and stderr split, structuredPatch, originalFile. Reading only the block
//     loses the diff. Both are exposed here; neither is silently preferred.
//  5. Records with no envelope (`queue-operation`, `last-prompt`, `ai-title`,
//     ...) have no `uuid` and CANNOT be tree nodes. They also carry no
//     `version`, so a scan keyed on `version` never sees them: a field it
//     reports "absent" there is absent from a population that is empty by
//     construction. They live in `sidecars`, counted, never in the forest.
//
//  ---- THE POINTER THAT MAKES THE TREE READABLE ------------------------------
//  `last-prompt.leafUuid` names the LEAF OF THE LIVE PATH. The tree can hold
//  many branches; this says which one the session was on. `livePath()` is
//  built on it, with a longest-path fallback when it is absent.
// ============================================================================

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- 1. Primitives ---------------------------------------------------------

export type Uuid = string;
/** Every vocabulary in this format is OPEN: new attachment types and new tool
 *  names keep arriving with new releases. `Open<T>` documents the values seen
 *  so far while still accepting the one that arrives next release. */
export type Open<T extends string> = T | (string & {});

export type RecordType = Open<
  | 'assistant' | 'user' | 'attachment' | 'system'
  | 'queue-operation' | 'last-prompt' | 'ai-title' | 'bridge-session'
  | 'atis-latch' | 'mode' | 'file-history-snapshot' | 'file-history-delta'
  | 'started' | 'result' | 'frame-link'
  | 'artifact-autoreact-ledger' | 'permission-mode' | 'artifact-comment-monitor'
>;

/** The envelope: the keys present on every conversational record, in every
 *  version observed. This is the ONLY part of a record that is safe to
 *  depend on. */
export interface Envelope {
  uuid: Uuid;
  parentUuid: Uuid | null;
  sessionId: string;
  timestamp: string;
  version: string;
  cwd: string;
  gitBranch: string;
  userType: string;
  entrypoint: string;
  isSidechain: boolean;
  type: RecordType;
}

// ---- 2. Content blocks -----------------------------------------------------

export type BlockType = Open<'text' | 'thinking' | 'redacted_thinking' | 'tool_use' | 'tool_result' | 'image'>;

export interface TextBlock      { type: 'text'; text: string }
export interface ThinkingBlock  { type: 'thinking'; thinking?: string; signature?: string }
export interface RedactedBlock  { type: 'redacted_thinking'; data?: string }
/** `caller` is present on nearly every tool_use block and appears in no
 *  release note and no doc. Blocks without it come from older CLI versions. */
export interface ToolUseBlock   { type: 'tool_use'; id: string; name: string; input?: Record<string, any>; caller?: string }
export interface ToolResultBlock{ type: 'tool_result'; tool_use_id: string; content?: string | any[]; is_error?: boolean }
export interface ImageBlock     { type: 'image'; source?: any }
export type ContentBlock = TextBlock | ThinkingBlock | RedactedBlock | ToolUseBlock | ToolResultBlock | ImageBlock | { type: string; [k: string]: any };

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number; [k: string]: any };
  [k: string]: any;
}

/** `message.content` is normally an array of blocks and sometimes a BARE
 *  STRING. Anything that does `content.filter(...)` without checking crashes
 *  on those. */
export interface Message {
  id?: string;
  role?: 'assistant' | 'user' | string;
  model?: string;
  content: ContentBlock[] | string;
  usage?: Usage;
  stop_reason?: string | null;
  [k: string]: any;
}

// ---- 3. Record types -------------------------------------------------------

export interface AssistantRecord extends Envelope {
  type: 'assistant';
  message: Message;
  requestId?: string;        // groups the blocks of one API response; absent on the oldest records
  effort?: string;           // added in CLI 2.1.212
  apiBlockIndex?: number;    // added in CLI 2.1.258: block order WITHIN a request
  agentId?: string;
  attributionAgent?: string; // undocumented
  attributionSkill?: string;
  isApiErrorMessage?: boolean;
  error?: any;
  [k: string]: any;
}

export interface UserRecord extends Envelope {
  type: 'user';
  message: Message;
  promptId: string;               // user-only; assistant carries requestId instead
  sourceToolAssistantUUID?: string; // on most tool results: links a result back to the calling block
  /** Undocumented, present in every version observed, and RICHER than the
   *  tool_result content block. Usually an object; a string in the error form. */
  toolUseResult?: any;
  permissionMode?: string;
  promptSource?: string;
  origin?: any;                   // a sibling of `message`, NOT inside it
  isMeta?: boolean;
  toolEndsTurn?: boolean;
  toolDenialKind?: string;
  agentId?: string;
  [k: string]: any;
}

export interface AttachmentRecord extends Envelope {
  type: 'attachment';
  attachment: { type: Open<string>; [k: string]: any };
  agentId?: string;
  rendered?: any;             // added in CLI 2.1.263
  renderedInHumanTurn?: any;  // added in CLI 2.1.263; rare
  [k: string]: any;
}

export interface SystemRecord extends Envelope {
  type: 'system';
  subtype: Open<'stop_hook_summary' | 'api_error' | 'turn_duration' | 'model_refusal_fallback' | 'away_summary' | 'local_command'>;
  level?: string;
  hookCount?: number; hookInfos?: any; hookErrors?: any;
  hookAdditionalContext?: any; preventedContinuation?: boolean;
  stopReason?: string; hasOutput?: boolean; toolUseID?: string;
  [k: string]: any;
}

/** No envelope at all: no uuid, sometimes no timestamp, never a `version`.
 *  These are session-scoped facts, not conversation nodes. */
export interface SidecarRecord { type: RecordType; sessionId?: string; [k: string]: any }

export type CCRecord = AssistantRecord | UserRecord | AttachmentRecord | SystemRecord | SidecarRecord;

// ---- 4. Parse results ------------------------------------------------------

export interface LineProblem {
  /** 1-indexed line number as it appears in the file. */
  line: number;
  /** Byte offset of the line start, so you can go find it with `dd`. */
  offset: number;
  bytes: number;
  reason: 'json' | 'not-object' | 'empty-after-strip';
  message: string;
  /** First 120 chars, escaped: enough to recognise, short enough to print.
   *  A corruption seen in practice is a run of NUL bytes before an otherwise
   *  intact record; this makes it visible instead of silent. */
  sample: string;
  /** True when the line contains NUL bytes, the corruption signature seen in practice. */
  hasNul: boolean;
}

export interface TreeNode {
  uuid: Uuid;
  parentUuid: Uuid | null;
  record: CCRecord & Envelope;
  children: TreeNode[];
  parent: TreeNode | null;
  /** Position in the file, 0-indexed, of the FIRST copy. File order is not tree order; keep both. */
  index: number;
  depth: number;
  /** How many times this uuid was written. Normally 1; more in a session that was compacted
   *  several times, where the harness writes whole runs of earlier history again. */
  copies: number;
}

/** One API response: the unit that a single request actually produced.
 *  This, not the record, is the thing to count. */
export interface ApiRequest {
  requestId: string;
  messageId?: string;
  model?: string;
  effort?: string;
  timestamp: string;
  /** Every assistant record of this request, in `apiBlockIndex` order where the
   *  field exists (added in CLI 2.1.258), else file order. */
  records: AssistantRecord[];
  blocks: ContentBlock[];
  /** Charged ONCE. Summing the usage repeated on each record overcounts. */
  usage?: Usage;
  /** input + cache_creation + cache_read. What the NEXT turn must carry.
   *  Output is charged separately and is not part of it. */
  contextLoad: number;
  outputTokens: number;
  thinkingTokens: number;
}

/** A tool_use paired with whatever came back, from either representation. */
export interface ToolCall {
  id: string;
  name: string;
  /** The HARNESS-NORMALIZED input, which is not always what the model emitted. The emission is the record's
   *  `wireToolInputs[id]` (on records that carry it, one entry per tool_use in that record). The two often
   *  differ: a leading `cd <cwd> && ` stripped from Bash commands, `replace_all: false` filled into Edit,
   *  occasionally Write content altered. A view that shows `input` shows the harness's rewrite. Since this
   *  is what ran, it is the sensible default for a viewer, provided it MARKS the calls where the two
   *  differ so the emission stays reachable (`wireInput`, `wireDiffers`). */
  input?: Record<string, any>;
  /** The arguments as the MODEL EMITTED them (`wireToolInputs[id]` on the same record), when the record carries them.
   *  Undefined on older transcripts: the field arrived with the wire-inputs record shape, and absence is not sameness. */
  wireInput?: Record<string, any>;
  /** True iff both exist and differ (key order normalised away). Typical differences: a redundant `cd <cwd> && `
   *  stripped, `replace_all: false` filled in, and escape sequences DECODED: the wire copy holds the characters
   *  the model typed, `input` holds the character the tool received. Agent transcripts differ less often than
   *  main sessions. The wire copy arrived in CLI 2.1.267: on anything older, absence is the format's age, not
   *  sameness. */
  wireDiffers?: boolean;
  caller?: string;
  callNode: TreeNode;
  resultNode?: TreeNode;
  /** The flattened string form, from the tool_result content block. */
  resultBlock?: ToolResultBlock;
  /** The structured form. Richer. Prefer it when present, but LOOK at both:
   *  they are two recordings of one event and can disagree. */
  toolUseResult?: any;
  isError: boolean;
  /** Large outputs spill to <session>/tool-results/<id>.txt and are NOT in the
   *  JSONL. When the content looks truncated this is where the rest lives. */
  spillFileHint: string;
}

/** There is more than one kind of .jsonl under a session directory, and only
 *  one of them is a conversation:
 *    - `transcript`: envelope-bearing records, one root each. The tree.
 *    - `journal`: <session>/subagents/workflows/wf_<id>/journal.jsonl, with
 *      ZERO envelope records; every record is `started`/`result` carrying the
 *      content-addressed key `v2:<sha256>` that lets a workflow resume replay a
 *      completed agent instead of re-running it.
 *  A journal parses to an EMPTY forest, and that is the correct answer, not a
 *  failure; but a bare `roots: 0` cannot say which. Hence this field: the zero
 *  arrives with its explanation attached. */
export type FileKind = 'transcript' | 'journal' | 'empty' | 'unknown';

export interface Transcript {
  /** What kind of file this was. Read it before reading `roots`. */
  fileKind: FileKind;
  /** Every record, in file order, nothing dropped. */
  records: CCRecord[];
  /** Where each record sits in the file, parallel to `records`. */
  positions: RecordPosition[];
  /** Envelope-bearing records only, by uuid. */
  nodes: Map<Uuid, TreeNode>;
  /** parentUuid === null. Normally exactly one; each compaction boundary adds another. */
  roots: TreeNode[];
  /** parentUuid set but not present in THIS file. Expected across files (a
   *  subagent transcript is a separate file) and a real finding within one. */
  orphans: TreeNode[];
  /** No-envelope records. Counted, never in the forest. */
  sidecars: SidecarRecord[];
  problems: LineProblem[];
  requests: ApiRequest[];
  toolCalls: ToolCall[];
  /** From the LAST `last-prompt.leafUuid`. Null when no such record exists. */
  liveLeafUuid: Uuid | null;
  stats: TranscriptStats;
}

export interface TranscriptStats {
  lines: number;
  parsed: number;
  unparseable: number;
  byType: Record<string, number>;
  byBlockType: Record<string, number>;
  byToolName: Record<string, number>;
  byAttachmentType: Record<string, number>;
  bySystemSubtype: Record<string, number>;
  versions: Record<string, number>;
  sessionIds: string[];
  isSidechain: boolean | 'mixed' | null;
  agentIds: string[];
  /** Nodes with more than one child: parallel tool calls, retries, hook races, rarely a rewind. */
  branchPoints: number;
  /** Input turns (typed, sdk, parent, input; see inputChannel()); harness-written user records excluded. */
  inputTurns: number;
  toolResultRecords: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  totalContextLoad: number;
  totalOutputTokens: number;
  /** Envelope records whose uuid was already written earlier in the file: REPLAYS, not events.
   *  Every count above is over first copies; `parsed` is still every line. Replays are written
   *  just before every manual /compact AFTER THE FIRST in a session: the history that earlier
   *  manual compactions summarized, written again. */
  replayedCopies: number;
  /** ...of which the bytes differ from the first copy (promptId, toolUseResult, slug, parentUuid). */
  replayedDiffering: number;
}

// ---- 5. Small helpers ------------------------------------------------------

const isObj = (v: unknown): v is Record<string, any> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The envelope test. A record is a tree node iff it has a uuid AND declares a
 *  parent slot. Both are present on every conversational record and absent on sidecars. */
export function hasEnvelope(r: any): r is CCRecord & Envelope {
  return isObj(r) && typeof r.uuid === 'string' && 'parentUuid' in r;
}

/** Normalise `message.content`, which is normally an array and sometimes a
 *  bare string. Never call `.filter` on it without going through here. */
export function blocksOf(m: Message | undefined | null): ContentBlock[] {
  if (!m) return [];
  const c = m.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
}

/** Trap 2. A tool result is `type:"user"`. Only the content shape separates it
 *  from a prompt. Getting this wrong makes every "turn" a tool result. */
export function isToolResultRecord(r: any): boolean {
  if (!isObj(r) || r.type !== 'user') return false;
  if ('toolUseResult' in r) return true;
  const b = blocksOf(r.message);
  return b.length > 0 && b[0]?.type === 'tool_result';
}

/** WHICH CHANNEL a user record's words came through. Never "human": a program typing into the
 *  terminal UI through a pty is recorded with `origin.kind: "human"` and `promptSource: "typed"`,
 *  field for field identical to a person typing. The harness labels the CHANNEL, not the actor, so a
 *  decoder that says "human" asserts more than the record does. The simpler predicate
 *  (`user` and not tool_result and not isMeta) gives harness-written text a person's voice:
 *  compaction summaries and command records come out as prompts.
 *
 *  Input channels (a turn starts here): typed, sdk, parent (a sidechain's delegating agent), loop, task, input (no field says).
 *  Harness-written (`harness:<kind>`, never a turn): compact-summary, meta, queued,
 *  command-output, interrupt. No single marker covers them (some task notifications lack
 *  queueSkipAttachments; wakeup-fired `/loop` records lack `origin`), so the order below is a union of tests.
 *  `loop`: a timer-fired `/loop` command (the user's words, written once as the /loop arguments and
 *  delivered by the scheduler) OPENS a turn on its own channel; otherwise every wakeup would sit inside
 *  one long turn, although the UserPromptSubmit hook fires on each of them. The skill body injected
 *  after it stays harness:meta.
 *  Where `promptSource` is absent (command records, older versions) the channel follows the harness's own
 *  convention for that entrypoint: cli means typed, any other entrypoint means sdk. A typed `/exit` is
 *  input; its `<local-command-stdout>` is not. */
export function inputChannel(r: any): string | undefined {
  if (!isObj(r) || r.type !== 'user' || isToolResultRecord(r)) return undefined;
  if (r.isCompactSummary === true) return 'harness:compact-summary';
  if (r.isMeta === true) return 'harness:meta';
  const lead = leadText(r);
  const kind = r.origin?.kind;
  if (kind === 'task-notification' || /^<task-notification>/.test(lead)) return 'task';   // a finished task's notification OPENS a turn
  if (r.queueSkipAttachments === true && /<command-name>\/loop<\/command-name>/.test(lead)) return 'loop';
  if (r.queueSkipAttachments === true) return 'harness:queued';
  if (/^<local-command-(stdout|stderr)>/.test(lead)) return 'harness:command-output';
  if (/^\[Request interrupted by user/.test(lead)) return 'harness:interrupt';
  if (r.isSidechain === true || kind === 'coordinator') return 'parent';
  if (typeof kind === 'string' && kind !== 'human') return kind;   // e.g. "peer": another agent's message, in the record's own word
  if (r.promptSource === 'typed' || r.promptSource === 'sdk') return r.promptSource;
  if (typeof r.entrypoint === 'string') return r.entrypoint === 'cli' ? 'typed' : 'sdk';
  return 'input';
}
/** A turn opens at input: any channel that is not harness-written. */
export function isInputTurn(r: any): boolean {
  const c = inputChannel(r);
  return c !== undefined && !c.startsWith('harness:');
}
function leadText(r: any): string {
  const c = r?.message?.content;
  const s = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('') : '';
  return s.trimStart();
}

const bump = (m: Record<string, number>, k: string | undefined | null) => {
  if (k === undefined || k === null) return;
  m[k] = (m[k] || 0) + 1;
};

// ---- 6. The line parser ----------------------------------------------------

/** Byte length without Buffer, so this file also runs in a browser. */
const byteLen = (s: string): number =>
  typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length;

export interface ParseOptions {
  /** Strip NUL bytes and retry a failed line (the corruption seen in practice is a run of
   *  NUL bytes before an intact object). Default false: a repair that happens silently is
   *  indistinguishable from clean data. When true, the line STILL appears in `problems`:
   *  repaired, not hidden. */
  repairNul?: boolean;
}

/** Where a record physically sits, so an index can point back at the bytes rather
 *  than at a copy of them. Parallel to `records`, same length, same order. */
export interface RecordPosition { line: number; offset: number; bytes: number }

/** Split, parse, and REPORT. Never throws on bad input; a bad line becomes a
 *  LineProblem carrying its byte offset so the raw bytes remain reachable. */
export function parseLines(text: string, opts: ParseOptions = {}): { records: CCRecord[]; positions: RecordPosition[]; problems: LineProblem[]; lines: number } {
  const records: CCRecord[] = [];
  const positions: RecordPosition[] = [];
  const problems: LineProblem[] = [];
  const lines = text.split('\n');
  let offset = 0;
  let n = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const len = byteLen(raw);
    const lineStart = offset;
    offset += len + 1; // + the \n we split on
    if (raw.trim() === '') continue;
    n++;

    const hasNul = raw.indexOf('\u0000') !== -1;
    const attempt = (s: string) => { try { return { ok: true as const, v: JSON.parse(s) }; } catch (e: any) { return { ok: false as const, e }; } };

    let r = attempt(raw);
    let repaired = false;
    if (!r.ok && hasNul && opts.repairNul) {
      const stripped = raw.replace(/\u0000+/g, '');
      if (stripped.trim() === '') {
        problems.push({ line: i + 1, offset: lineStart, bytes: len, reason: 'empty-after-strip', message: 'line was NUL padding only', sample: '', hasNul: true });
        continue;
      }
      const r2 = attempt(stripped);
      if (r2.ok) { r = r2; repaired = true; }
    }

    if (!r.ok) {
      problems.push({
        line: i + 1, offset: lineStart, bytes: len, reason: 'json',
        message: String(r.e?.message ?? r.e), hasNul,
        sample: JSON.stringify(raw.slice(0, 120)),
      });
      continue;
    }
    if (!isObj(r.v)) {
      problems.push({ line: i + 1, offset: lineStart, bytes: len, reason: 'not-object', message: `top-level ${Array.isArray(r.v) ? 'array' : typeof r.v}`, hasNul, sample: JSON.stringify(raw.slice(0, 120)) });
      continue;
    }
    if (repaired) {
      problems.push({ line: i + 1, offset: lineStart, bytes: len, reason: 'json', message: 'REPAIRED: NUL bytes stripped, record recovered', hasNul: true, sample: JSON.stringify(raw.slice(0, 120)) });
    }
    records.push(r.v as CCRecord);
    positions.push({ line: i + 1, offset: lineStart, bytes: len });
  }
  return { records, positions, problems, lines: n };
}

// ---- 7. The forest ---------------------------------------------------------

function buildForest(records: CCRecord[]) {
  const nodes = new Map<Uuid, TreeNode>();
  const roots: TreeNode[] = [];
  const orphans: TreeNode[] = [];
  const sidecars: SidecarRecord[] = [];

  records.forEach((r, index) => {
    if (!hasEnvelope(r)) { sidecars.push(r as SidecarRecord); return; }
    // FIRST write wins on a duplicate uuid. Duplicates occur in compacted sessions, where the
    //   harness writes runs of earlier records again, and some of those copies RE-PARENT the
    //   compaction's preserved segment under the summary. Under last-write-wins the tree can
    //   loop: climbing parents from a boundary's logicalParentUuid passes through the summary
    //   and back into that same boundary. Under first-write-wins each boundary's logical
    //   parent climbs cleanly to the PREVIOUS boundary, never passing the boundary or its
    //   summary. The first copy is when it happened; a replay is a later rewrite of it.
    //   Copies are counted, never merged silently.
    const prev = nodes.get(r.uuid);
    if (prev) { prev.copies++; return; }
    nodes.set(r.uuid, { uuid: r.uuid, parentUuid: r.parentUuid ?? null, record: r, children: [], parent: null, index, depth: 0, copies: 1 });
  });

  for (const node of nodes.values()) {
    if (node.parentUuid === null || node.parentUuid === undefined) { roots.push(node); continue; }
    const p = nodes.get(node.parentUuid);
    if (!p) { orphans.push(node); continue; }   // cross-file link, or a real gap
    node.parent = p;
    p.children.push(node);
  }

  // Children in file order: the order they actually happened.
  for (const n of nodes.values()) n.children.sort((a, b) => a.index - b.index);

  // Depth, iteratively: a deep transcript would blow a recursive stack.
  const stack = [...roots, ...orphans];
  for (const r of stack) r.depth = 0;
  while (stack.length) {
    const n = stack.pop()!;
    for (const c of n.children) { c.depth = n.depth + 1; stack.push(c); }
  }

  roots.sort((a, b) => a.index - b.index);
  orphans.sort((a, b) => a.index - b.index);
  return { nodes, roots, orphans, sidecars };
}

// ---- 8. Requests: traps 1 and 3 --------------------------------------------

/** Parallel to `records`: true where the record is a REPLAY, an envelope record whose uuid was
 *  already written earlier in the file. Sidecars (no uuid) are never replays; a repeated
 *  `last-prompt` is a head that moved, an event of its own. */
export function replayMask(records: CCRecord[]): boolean[] {
  const seen = new Set<string>();
  return records.map((r) => {
    if (!hasEnvelope(r)) return false;
    if (seen.has(r.uuid)) return true;
    seen.add(r.uuid); return false;
  });
}

function buildRequests(records: CCRecord[], replay: boolean[]): ApiRequest[] {
  const byId = new Map<string, ApiRequest>();
  const order: string[] = [];
  // Usage repeats across the records of one request; charge each message.id once.
  const chargedMessageIds = new Set<string>();

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.type !== 'assistant' || replay[i]) continue;   // a replayed block is not a second block
    const a = r as AssistantRecord;
    // Records written before requestId existed (the oldest versions) still deserve a group
    // of their own rather than being merged into one bucket keyed on undefined.
    const key = a.requestId ?? `uuid:${a.uuid}`;
    let g = byId.get(key);
    if (!g) {
      g = {
        requestId: key, messageId: a.message?.id, model: a.message?.model,
        effort: a.effort, timestamp: a.timestamp, records: [], blocks: [],
        usage: undefined, contextLoad: 0, outputTokens: 0, thinkingTokens: 0,
      };
      byId.set(key, g); order.push(key);
    }
    g.records.push(a);
    const mid = a.message?.id;
    const u = a.message?.usage;
    if (u && (!mid || !chargedMessageIds.has(mid))) {
      if (mid) chargedMessageIds.add(mid);
      g.usage = u;
      g.contextLoad += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      g.outputTokens += u.output_tokens || 0;
      g.thinkingTokens += u.output_tokens_details?.thinking_tokens || 0;
    }
  }

  for (const g of byId.values()) {
    // apiBlockIndex orders blocks within a request where it exists (added in CLI
    // 2.1.258). Where it does not, file order is the only order there is.
    const haveIdx = g.records.every((r) => typeof r.apiBlockIndex === 'number');
    if (haveIdx) g.records.sort((a, b) => (a.apiBlockIndex! - b.apiBlockIndex!));
    g.blocks = g.records.flatMap((r) => blocksOf(r.message));
  }
  return order.map((k) => byId.get(k)!);
}

// ---- 9. Tool calls: trap 4 -------------------------------------------------

/** Key order must not decide whether two inputs "differ", so sort it away. No dependency, browser-safe. */
function stable(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

function buildToolCalls(nodes: Map<Uuid, TreeNode>, records: CCRecord[], replay: boolean[]): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  const nodeByIndex: TreeNode[] = [];
  for (const n of nodes.values()) nodeByIndex[n.index] = n;

  for (const n of nodes.values()) {
    if (n.record.type !== 'assistant') continue;
    for (const b of blocksOf((n.record as AssistantRecord).message)) {
      if (b.type !== 'tool_use') continue;
      const t = b as ToolUseBlock;
      const wire = (n.record as any).wireToolInputs?.[t.id];
      calls.set(t.id, {
        id: t.id, name: t.name, input: t.input, caller: t.caller,
        wireInput: wire, wireDiffers: wire !== undefined && stable(wire) !== stable(t.input),
        callNode: n, isError: false,
        spillFileHint: `<session>/tool-results/${t.id}.txt`,
      });
    }
  }

  records.forEach((r, index) => {
    if (r.type !== 'user' || replay[index]) return;   // a replay has no node at its own index
    const u = r as UserRecord;
    const node = hasEnvelope(u) ? nodeByIndex[index] : undefined;
    for (const b of blocksOf(u.message)) {
      if (b.type !== 'tool_result') continue;
      const tr = b as ToolResultBlock;
      const call = calls.get(tr.tool_use_id);
      if (!call) continue;               // result whose call is in another file
      call.resultBlock = tr;
      call.resultNode = node;
      call.isError = tr.is_error === true || typeof u.toolUseResult === 'string';
      if ('toolUseResult' in u) call.toolUseResult = u.toolUseResult;
    }
  });
  return [...calls.values()].sort((a, b) => a.callNode.index - b.callNode.index);
}

// ---- 10. The whole thing ---------------------------------------------------

export function parseTranscript(text: string, opts: ParseOptions = {}): Transcript {
  const { records, positions, problems, lines } = parseLines(text, opts);
  const { nodes, roots, orphans, sidecars } = buildForest(records);
  const replay = replayMask(records);
  const requests = buildRequests(records, replay);
  const toolCalls = buildToolCalls(nodes, records, replay);

  const stats: TranscriptStats = {
    lines, parsed: records.length, unparseable: problems.filter((p) => p.reason !== 'json' || !/REPAIRED/.test(p.message)).length,
    byType: {}, byBlockType: {}, byToolName: {}, byAttachmentType: {}, bySystemSubtype: {},
    versions: {}, sessionIds: [], isSidechain: null, agentIds: [],
    branchPoints: 0, inputTurns: 0, toolResultRecords: 0,
    firstTimestamp: null, lastTimestamp: null,
    totalContextLoad: 0, totalOutputTokens: 0,
    replayedCopies: 0, replayedDiffering: 0,
  };

  const sids = new Set<string>(); const aids = new Set<string>(); const sc = new Set<boolean>();
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (replay[i]) {
      // counted, never merged: a replay is reported, and every census below is over first copies
      stats.replayedCopies++;
      const first = nodes.get((r as any).uuid)!.record;
      if (JSON.stringify(first) !== JSON.stringify(r)) stats.replayedDiffering++;
      continue;
    }
    bump(stats.byType, r.type as string);
    if ((r as any).version) bump(stats.versions, (r as any).version);
    if ((r as any).sessionId) sids.add((r as any).sessionId);
    if ((r as any).agentId) aids.add((r as any).agentId);
    if (typeof (r as any).isSidechain === 'boolean') sc.add((r as any).isSidechain);
    const ts = (r as any).timestamp;
    if (typeof ts === 'string') {
      if (!stats.firstTimestamp || ts < stats.firstTimestamp) stats.firstTimestamp = ts;
      if (!stats.lastTimestamp || ts > stats.lastTimestamp) stats.lastTimestamp = ts;
    }
    if (r.type === 'assistant' || r.type === 'user') {
      for (const b of blocksOf((r as any).message)) {
        bump(stats.byBlockType, b.type);
        if (b.type === 'tool_use') bump(stats.byToolName, (b as ToolUseBlock).name);
      }
    }
    if (r.type === 'attachment') bump(stats.byAttachmentType, (r as AttachmentRecord).attachment?.type);
    if (r.type === 'system') bump(stats.bySystemSubtype, (r as SystemRecord).subtype);
    if (isInputTurn(r)) stats.inputTurns++;
    if (isToolResultRecord(r)) stats.toolResultRecords++;
  }
  stats.sessionIds = [...sids]; stats.agentIds = [...aids];
  stats.isSidechain = sc.size === 0 ? null : sc.size > 1 ? 'mixed' : [...sc][0];
  for (const n of nodes.values()) if (n.children.length > 1) stats.branchPoints++;
  for (const g of requests) { stats.totalContextLoad += g.contextLoad; stats.totalOutputTokens += g.outputTokens; }

  // The live-path pointer. The last one wins: it is rewritten as the head moves.
  let liveLeafUuid: Uuid | null = null;
  for (const r of records) if (r.type === 'last-prompt' && typeof (r as any).leafUuid === 'string') liveLeafUuid = (r as any).leafUuid;

  const fileKind: FileKind =
    nodes.size > 0 ? 'transcript'
    : records.length === 0 ? 'empty'
    : records.every((r) => r.type === 'started' || r.type === 'result') ? 'journal'
    : 'unknown';

  return { fileKind, records, positions, nodes, roots, orphans, sidecars, problems, requests, toolCalls, liveLeafUuid, stats };
}

// ---- 11. Views over the tree -----------------------------------------------

/** Root to node, inclusive. The path is the conversation; the tree is everything
 *  that was ever on the way there, including what was rewound past. */
export function pathTo(t: Transcript, uuid: Uuid): TreeNode[] {
  const out: TreeNode[] = [];
  let n = t.nodes.get(uuid) ?? null;
  const guard = new Set<Uuid>();       // a cycle cannot happen; do not hang if it does
  while (n && !guard.has(n.uuid)) { guard.add(n.uuid); out.push(n); n = n.parent; }
  return out.reverse();
}

/** The conversation as it actually stood at the end.
 *  Primary: the `last-prompt.leafUuid` pointer. Fallback: the deepest leaf,
 *  stated as a fallback because it is a GUESS and the pointer is a FACT. */
export function livePath(t: Transcript): { path: TreeNode[]; from: 'leafUuid' | 'deepest-leaf' | 'none' } {
  if (t.liveLeafUuid && t.nodes.has(t.liveLeafUuid)) return { path: pathTo(t, t.liveLeafUuid), from: 'leafUuid' };
  let best: TreeNode | null = null;
  for (const n of t.nodes.values()) {
    if (n.children.length) continue;
    if (!best || n.depth > best.depth || (n.depth === best.depth && n.index > best.index)) best = n;
  }
  return best ? { path: pathTo(t, best.uuid), from: 'deepest-leaf' } : { path: [], from: 'none' };
}

/** THE LIVE PATH, REPAIRED. livePath() walks parentUuid up from the head pointer and labels the
 *  answer `from:'leafUuid'`, a FACT's provenance. Some harness behaviours make the parentUuid chain
 *  misroute while that label stays confident. This function repairs them and REPORTS every repair,
 *  by the rule `repairNul` follows: a repair that happens silently is indistinguishable from clean data.
 *
 *  (1) THE LATE-WRITTEN API ERROR: `splices`. When a request fails (ECONNRESET, for example) the
 *    harness retries and the turn goes on; only at its end is the `system:api_error` record written,
 *    parented to the pre-error tip, and the turn's closing record then chains onto the ERROR. The
 *    parentUuid tree routes the live path around the entire retried turn, so every assistant text
 *    block and tool call in it is invisible to a live-path reader. The branch that looks dead is
 *    the SUCCESSFUL continuation, not the failed attempt.
 *    Signature: the error record is written after every node of the other branch AND that branch
 *    runs past the error's own timestamp (it begins after it, or straddles it: the failing
 *    attempt's partial output with the retry chained on). The mirror case, a failed attempt wholly
 *    before a promptly written error, has not been observed; the second condition exists so that
 *    case, if it ever appears, is left alone rather than spliced.
 *    Repair: the error stays where the tree puts it, and the branch (from the fork to its
 *    last-written node) is inserted between the error and the error's descendants.
 *    The same shape occurs with `system:stop_hook_summary` and occasionally with a user record,
 *    so the splice keys on the SIGNATURE (happened before, written after all of a sibling branch
 *    that runs past it), and reports the late record's type.
 *
 *  (2) THE DISCARDED PARENT: `bridges`. The harness record "The previous response failed to produce
 *    a valid tool call. Please retry" can carry a parentUuid that names the discarded response,
 *    which was never written. livePath() stops at that orphan and loses everything before it.
 *    Repair: continue from the envelope node written immediately before the orphan (FILE ORDER:
 *    a proxy for the missing link, named as one).
 *
 *  (4) THE COMPACTION BOUNDARY: `compactions`. Each compaction writes a `system:compact_boundary`
 *    as a NEW ROOT (parentUuid null) carrying `logicalParentUuid` = the last node before it
 *    (equal to compactMetadata.preservedSegment.tailUuid), with the summary as its only child.
 *    livePath() stops at that root, so a view built on it opens at the last boundary, as if the
 *    file had dropped its beginning; the file still holds every message.
 *    Repair: at a root whose logicalParentUuid resolves, continue from the logical parent. With
 *    first-write-wins parents (see buildForest) each climb ends at the previous boundary.
 *    The joined path is the SESSION'S HISTORY, not the model's context: after a boundary the
 *    model sees the summary, not what precedes it. Each join is reported with its compactMetadata
 *    so a reader can tell the two apart.
 *
 *  The independent check is the harness's OWN head pointer: every `last-prompt.leafUuid` the
 *  session ever wrote marks a node the head stood on, so each should lie on the true path. */
export interface Bridge { orphan: TreeNode; via: TreeNode; missingParent: Uuid; kind: 'file-order' }
export interface Splice { error: TreeNode; fork: TreeNode; branch: TreeNode[]; kind: 'late-write'; lateType: string }
/** (3) the head pointer written before the session's last records; see below */
export interface Extension { leaf: TreeNode; to: TreeNode; records: number; kind: 'stale-head' }
/** (4) a compaction boundary crossed: the model's context was replaced by a summary here */
export interface CompactionJoin {
  boundary: TreeNode; logicalParent: TreeNode; kind: 'compaction';
  /** which of the two known shapes carried the join, and the node it continued from */
  via: 'logical-parent' | 'preserved-head'; joinedAt: TreeNode;
  trigger: string | null; preTokens: number | null; postTokens: number | null; durationMs: number | null;
}
export function repairedLivePath(t: Transcript): { path: TreeNode[]; from: 'leafUuid' | 'deepest-leaf' | 'none'; bridges: Bridge[]; splices: Splice[]; extension: Extension | null; compactions: CompactionJoin[] } {
  const base = livePath(t);
  const bridges: Bridge[] = [];
  const splices: Splice[] = [];
  const compactions: CompactionJoin[] = [];
  let path = base.path;
  let extension: Extension | null = null;

  // (3) A STALE HEAD: the final `leafUuid` names a node that HAS CHILDREN. This happens when the
  //    last `last-prompt` record was written before the session's final exchange, which then sits
  //    below it. A leaf with children is not a leaf, so the signal is unambiguous; the path is
  //    extended to the LAST-WRITTEN descendant.
  const tip = path[path.length - 1];
  if (tip && tip.children.length) {
    let last: TreeNode = tip, n = 0;
    const st = [...tip.children];
    while (st.length) { const x = st.pop()!; n++; if (x.index > last.index) last = x; st.push(...x.children); }
    extension = { leaf: tip, to: last, records: n, kind: 'stale-head' };
    path = pathTo(t, last.uuid);
  }

  // (2) bridges and (4) compaction joins first: a truncated path has nothing above it to splice.
  //    One loop, because a segment joined across a compaction can itself start at an orphan or at
  //    an earlier boundary.
  const byIndex = [...t.nodes.values()].sort((a, b) => a.index - b.index);
  const pos = new Map(byIndex.map((n, i) => [n.uuid, i] as const));
  const guard = new Set<Uuid>();
  const logicalOf = (n: TreeNode): TreeNode | undefined => {
    const lp = (n.record as any).logicalParentUuid;
    return n.parentUuid === null && typeof lp === 'string' ? t.nodes.get(lp) : undefined;
  };
  while (path.length && path[0].parent === null && (path[0].parentUuid || logicalOf(path[0]))) {
    const head = path[0];
    if (guard.has(head.uuid)) break;
    guard.add(head.uuid);
    const inPath = new Set(path.map((n) => n.uuid));
    const logical = logicalOf(head);
    if (logical) {
      const m = (head.record as any).compactMetadata ?? {};
      const join = (to: TreeNode, via: CompactionJoin['via']) => {
        compactions.unshift({
          boundary: head, logicalParent: logical, kind: 'compaction', via, joinedAt: to,
          trigger: m.trigger ?? null, preTokens: m.preTokens ?? null, postTokens: m.postTokens ?? null, durationMs: m.durationMs ?? null,
        });
        path = [...pathTo(t, to.uuid), ...path];
      };
      // SHAPE 1 (seen from the VS Code extension and from headless -p): the logical parent was
      //   written BEFORE the boundary. In a PARTIAL compaction (from the rewind menu) the logical
      //   parent is the record just before the SELECTED prompt, and the segment after it (kept by
      //   "Summarize up to here", summarized by "from here") hangs below it, written before the
      //   boundary; joining at the logical parent itself would drop the prompts in that segment.
      //   So continue from its last-written descendant that precedes the boundary. A full
      //   compaction has none, so there the tip is the logical parent and nothing changes.
      if (!inPath.has(logical.uuid) && logical.index < head.index) {
        let tip = logical; const st = [...logical.children];
        while (st.length) { const x = st.pop()!; if (x.index < head.index && x.index > tip.index && !inPath.has(x.uuid)) tip = x; st.push(...x.children); }
        join(tip, 'logical-parent');
        continue;
      }
      // SHAPE 2 (seen from the terminal UI): the preserved segment's TAIL is written AFTER the
      //   boundary (boundary, then summary, then tail) and logicalParentUuid names that tail: a
      //   pointer into the boundary's own segment. The history before it hangs off
      //   preservedSegment.headUuid, written before the boundary. Continue from the last-written
      //   descendant of the head that PRECEDES the boundary.
      const hd = typeof m.preservedSegment?.headUuid === 'string' ? t.nodes.get(m.preservedSegment.headUuid) : undefined;
      if (hd && !inPath.has(hd.uuid) && hd.index < head.index) {
        let tip = hd; const st = [...hd.children];
        while (st.length) { const x = st.pop()!; if (x.index < head.index && x.index > tip.index && !inPath.has(x.uuid)) tip = x; st.push(...x.children); }
        join(tip, 'preserved-head');
        continue;
      }
      break;                                        // neither shape: leave the path as it is, never loop
    }
    const orphan = head;
    let via: TreeNode | undefined;
    for (let i = (pos.get(orphan.uuid) ?? 0) - 1; i >= 0; i--) if (!inPath.has(byIndex[i].uuid)) { via = byIndex[i]; break; }
    if (!via) break;
    bridges.push({ orphan, via, missingParent: orphan.parentUuid!, kind: 'file-order' });
    path = [...pathTo(t, via.uuid), ...path];
  }

  // (1) splices: walk the path; at P -> E, insert the branch E was written after. Keyed on the
  //    SIGNATURE, not on E's type: the same shape occurs with `system:stop_hook_summary` as the
  //    late record (a Stop hook blocked stopping, the model worked on, and the summary was written
  //    at the real end) and occasionally with a user record. A genuine rewind fails the test by
  //    construction: the new prompt is LATER than everything it abandons, so nothing "runs past" it.
  const ts = (n: TreeNode) => String((n.record as any).timestamp ?? '');
  const out: TreeNode[] = [];
  for (let i = 0; i < path.length; i++) {
    const E = path[i];
    out.push(E);
    const P = path[i - 1];
    const r: any = E.record;
    if (!P || E.parent !== P || P.children.length < 2) continue;
    let last: TreeNode | null = null;
    const stack = P.children.filter((c) => c !== E);
    while (stack.length) {
      const x = stack.pop()!;
      if (x.index < E.index && (!last || x.index > last.index)) last = x;
      stack.push(...x.children);
    }
    if (!last) continue;
    const upToP = pathTo(t, P.uuid).length;
    const branch = pathTo(t, last.uuid).slice(upToP);
    const written = branch.every((x) => x.index < E.index);
    const runsPast = branch.some((x) => ts(x) > ts(E));
    if (!branch.length || !written || !runsPast) continue;
    out.push(...branch);
    splices.push({ error: E, fork: P, branch, kind: 'late-write', lateType: r.type + (r.subtype ? ':' + r.subtype : '') });
  }
  return { path: out, from: base.from, bridges, splices, extension, compactions };
}

/** Input turns with what followed, up to the next input turn.
 *  This is the unit a reader actually thinks in. */
export interface Turn { prompt: TreeNode; records: TreeNode[]; requests: ApiRequest[]; toolCalls: ToolCall[] }
export function turnsOf(t: Transcript, path?: TreeNode[]): Turn[] {
  const seq = path ?? livePath(t).path;
  const out: Turn[] = [];
  let cur: Turn | null = null;
  for (const n of seq) {
    if (isInputTurn(n.record)) { cur = { prompt: n, records: [], requests: [], toolCalls: [] }; out.push(cur); continue; }
    if (!cur) continue;
    cur.records.push(n);
  }
  const reqByUuid = new Map<Uuid, ApiRequest>();
  for (const g of t.requests) for (const r of g.records) reqByUuid.set(r.uuid, g);
  for (const turn of out) {
    const seen = new Set<ApiRequest>();
    for (const n of turn.records) { const g = reqByUuid.get(n.uuid); if (g && !seen.has(g)) { seen.add(g); turn.requests.push(g); } }
    const idx = new Set(turn.records.map((n) => n.index));
    turn.toolCalls = t.toolCalls.filter((c) => idx.has(c.callNode.index));
  }
  return out;
}
