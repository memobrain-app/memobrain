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
// ---- 5. Small helpers ------------------------------------------------------
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** The envelope test. A record is a tree node iff it has a uuid AND declares a
 *  parent slot. Both are present on every conversational record and absent on sidecars. */
export function hasEnvelope(r) {
    return isObj(r) && typeof r.uuid === 'string' && 'parentUuid' in r;
}
/** Normalise `message.content`, which is normally an array and sometimes a
 *  bare string. Never call `.filter` on it without going through here. */
export function blocksOf(m) {
    if (!m)
        return [];
    const c = m.content;
    if (typeof c === 'string')
        return [{ type: 'text', text: c }];
    return Array.isArray(c) ? c : [];
}
/** Trap 2. A tool result is `type:"user"`. Only the content shape separates it
 *  from a prompt. Getting this wrong makes every "turn" a tool result. */
export function isToolResultRecord(r) {
    if (!isObj(r) || r.type !== 'user')
        return false;
    if ('toolUseResult' in r)
        return true;
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
export function inputChannel(r) {
    if (!isObj(r) || r.type !== 'user' || isToolResultRecord(r))
        return undefined;
    if (r.isCompactSummary === true)
        return 'harness:compact-summary';
    if (r.isMeta === true)
        return 'harness:meta';
    const lead = leadText(r);
    const kind = r.origin?.kind;
    if (kind === 'task-notification' || /^<task-notification>/.test(lead))
        return 'task'; // a finished task's notification OPENS a turn
    if (r.queueSkipAttachments === true && /<command-name>\/loop<\/command-name>/.test(lead))
        return 'loop';
    if (r.queueSkipAttachments === true)
        return 'harness:queued';
    if (/^<local-command-(stdout|stderr)>/.test(lead))
        return 'harness:command-output';
    if (/^\[Request interrupted by user/.test(lead))
        return 'harness:interrupt';
    if (r.isSidechain === true || kind === 'coordinator')
        return 'parent';
    if (typeof kind === 'string' && kind !== 'human')
        return kind; // e.g. "peer": another agent's message, in the record's own word
    if (r.promptSource === 'typed' || r.promptSource === 'sdk')
        return r.promptSource;
    if (typeof r.entrypoint === 'string')
        return r.entrypoint === 'cli' ? 'typed' : 'sdk';
    return 'input';
}
/** A turn opens at input: any channel that is not harness-written. */
export function isInputTurn(r) {
    const c = inputChannel(r);
    return c !== undefined && !c.startsWith('harness:');
}
function leadText(r) {
    const c = r?.message?.content;
    const s = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('') : '';
    return s.trimStart();
}
const bump = (m, k) => {
    if (k === undefined || k === null)
        return;
    m[k] = (m[k] || 0) + 1;
};
// ---- 6. The line parser ----------------------------------------------------
/** Byte length without Buffer, so this file also runs in a browser. */
const byteLen = (s) => typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length;
/** Split, parse, and REPORT. Never throws on bad input; a bad line becomes a
 *  LineProblem carrying its byte offset so the raw bytes remain reachable. */
export function parseLines(text, opts = {}) {
    const records = [];
    const positions = [];
    const problems = [];
    const lines = text.split('\n');
    let offset = 0;
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const len = byteLen(raw);
        const lineStart = offset;
        offset += len + 1; // + the \n we split on
        if (raw.trim() === '')
            continue;
        n++;
        const hasNul = raw.indexOf('\u0000') !== -1;
        const attempt = (s) => { try {
            return { ok: true, v: JSON.parse(s) };
        }
        catch (e) {
            return { ok: false, e };
        } };
        let r = attempt(raw);
        let repaired = false;
        if (!r.ok && hasNul && opts.repairNul) {
            const stripped = raw.replace(/\u0000+/g, '');
            if (stripped.trim() === '') {
                problems.push({ line: i + 1, offset: lineStart, bytes: len, reason: 'empty-after-strip', message: 'line was NUL padding only', sample: '', hasNul: true });
                continue;
            }
            const r2 = attempt(stripped);
            if (r2.ok) {
                r = r2;
                repaired = true;
            }
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
        records.push(r.v);
        positions.push({ line: i + 1, offset: lineStart, bytes: len });
    }
    return { records, positions, problems, lines: n };
}
// ---- 7. The forest ---------------------------------------------------------
function buildForest(records) {
    const nodes = new Map();
    const roots = [];
    const orphans = [];
    const sidecars = [];
    records.forEach((r, index) => {
        if (!hasEnvelope(r)) {
            sidecars.push(r);
            return;
        }
        // FIRST write wins on a duplicate uuid. Duplicates occur in compacted sessions, where the
        //   harness writes runs of earlier records again, and some of those copies RE-PARENT the
        //   compaction's preserved segment under the summary. Under last-write-wins the tree can
        //   loop: climbing parents from a boundary's logicalParentUuid passes through the summary
        //   and back into that same boundary. Under first-write-wins each boundary's logical
        //   parent climbs cleanly to the PREVIOUS boundary, never passing the boundary or its
        //   summary. The first copy is when it happened; a replay is a later rewrite of it.
        //   Copies are counted, never merged silently.
        const prev = nodes.get(r.uuid);
        if (prev) {
            prev.copies++;
            return;
        }
        nodes.set(r.uuid, { uuid: r.uuid, parentUuid: r.parentUuid ?? null, record: r, children: [], parent: null, index, depth: 0, copies: 1 });
    });
    for (const node of nodes.values()) {
        if (node.parentUuid === null || node.parentUuid === undefined) {
            roots.push(node);
            continue;
        }
        const p = nodes.get(node.parentUuid);
        if (!p) {
            orphans.push(node);
            continue;
        } // cross-file link, or a real gap
        node.parent = p;
        p.children.push(node);
    }
    // Children in file order: the order they actually happened.
    for (const n of nodes.values())
        n.children.sort((a, b) => a.index - b.index);
    // Depth, iteratively: a deep transcript would blow a recursive stack.
    const stack = [...roots, ...orphans];
    for (const r of stack)
        r.depth = 0;
    while (stack.length) {
        const n = stack.pop();
        for (const c of n.children) {
            c.depth = n.depth + 1;
            stack.push(c);
        }
    }
    roots.sort((a, b) => a.index - b.index);
    orphans.sort((a, b) => a.index - b.index);
    return { nodes, roots, orphans, sidecars };
}
// ---- 8. Requests: traps 1 and 3 --------------------------------------------
/** Parallel to `records`: true where the record is a REPLAY, an envelope record whose uuid was
 *  already written earlier in the file. Sidecars (no uuid) are never replays; a repeated
 *  `last-prompt` is a head that moved, an event of its own. */
export function replayMask(records) {
    const seen = new Set();
    return records.map((r) => {
        if (!hasEnvelope(r))
            return false;
        if (seen.has(r.uuid))
            return true;
        seen.add(r.uuid);
        return false;
    });
}
function buildRequests(records, replay) {
    const byId = new Map();
    const order = [];
    // Usage repeats across the records of one request; charge each message.id once.
    const chargedMessageIds = new Set();
    for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (r.type !== 'assistant' || replay[i])
            continue; // a replayed block is not a second block
        const a = r;
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
            byId.set(key, g);
            order.push(key);
        }
        g.records.push(a);
        const mid = a.message?.id;
        const u = a.message?.usage;
        if (u && (!mid || !chargedMessageIds.has(mid))) {
            if (mid)
                chargedMessageIds.add(mid);
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
        if (haveIdx)
            g.records.sort((a, b) => (a.apiBlockIndex - b.apiBlockIndex));
        g.blocks = g.records.flatMap((r) => blocksOf(r.message));
    }
    return order.map((k) => byId.get(k));
}
// ---- 9. Tool calls: trap 4 -------------------------------------------------
/** Key order must not decide whether two inputs "differ", so sort it away. No dependency, browser-safe. */
function stable(v) {
    if (v === null || typeof v !== 'object')
        return JSON.stringify(v) ?? 'undefined';
    if (Array.isArray(v))
        return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
function buildToolCalls(nodes, records, replay) {
    const calls = new Map();
    const nodeByIndex = [];
    for (const n of nodes.values())
        nodeByIndex[n.index] = n;
    for (const n of nodes.values()) {
        if (n.record.type !== 'assistant')
            continue;
        for (const b of blocksOf(n.record.message)) {
            if (b.type !== 'tool_use')
                continue;
            const t = b;
            const wire = n.record.wireToolInputs?.[t.id];
            calls.set(t.id, {
                id: t.id, name: t.name, input: t.input, caller: t.caller,
                wireInput: wire, wireDiffers: wire !== undefined && stable(wire) !== stable(t.input),
                callNode: n, isError: false,
                spillFileHint: `<session>/tool-results/${t.id}.txt`,
            });
        }
    }
    records.forEach((r, index) => {
        if (r.type !== 'user' || replay[index])
            return; // a replay has no node at its own index
        const u = r;
        const node = hasEnvelope(u) ? nodeByIndex[index] : undefined;
        for (const b of blocksOf(u.message)) {
            if (b.type !== 'tool_result')
                continue;
            const tr = b;
            const call = calls.get(tr.tool_use_id);
            if (!call)
                continue; // result whose call is in another file
            call.resultBlock = tr;
            call.resultNode = node;
            call.isError = tr.is_error === true || typeof u.toolUseResult === 'string';
            if ('toolUseResult' in u)
                call.toolUseResult = u.toolUseResult;
        }
    });
    return [...calls.values()].sort((a, b) => a.callNode.index - b.callNode.index);
}
// ---- 10. The whole thing ---------------------------------------------------
export function parseTranscript(text, opts = {}) {
    const { records, positions, problems, lines } = parseLines(text, opts);
    const { nodes, roots, orphans, sidecars } = buildForest(records);
    const replay = replayMask(records);
    const requests = buildRequests(records, replay);
    const toolCalls = buildToolCalls(nodes, records, replay);
    const stats = {
        lines, parsed: records.length, unparseable: problems.filter((p) => p.reason !== 'json' || !/REPAIRED/.test(p.message)).length,
        byType: {}, byBlockType: {}, byToolName: {}, byAttachmentType: {}, bySystemSubtype: {},
        versions: {}, sessionIds: [], isSidechain: null, agentIds: [],
        branchPoints: 0, inputTurns: 0, toolResultRecords: 0,
        firstTimestamp: null, lastTimestamp: null,
        totalContextLoad: 0, totalOutputTokens: 0,
        replayedCopies: 0, replayedDiffering: 0,
    };
    const sids = new Set();
    const aids = new Set();
    const sc = new Set();
    for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (replay[i]) {
            // counted, never merged: a replay is reported, and every census below is over first copies
            stats.replayedCopies++;
            const first = nodes.get(r.uuid).record;
            if (JSON.stringify(first) !== JSON.stringify(r))
                stats.replayedDiffering++;
            continue;
        }
        bump(stats.byType, r.type);
        if (r.version)
            bump(stats.versions, r.version);
        if (r.sessionId)
            sids.add(r.sessionId);
        if (r.agentId)
            aids.add(r.agentId);
        if (typeof r.isSidechain === 'boolean')
            sc.add(r.isSidechain);
        const ts = r.timestamp;
        if (typeof ts === 'string') {
            if (!stats.firstTimestamp || ts < stats.firstTimestamp)
                stats.firstTimestamp = ts;
            if (!stats.lastTimestamp || ts > stats.lastTimestamp)
                stats.lastTimestamp = ts;
        }
        if (r.type === 'assistant' || r.type === 'user') {
            for (const b of blocksOf(r.message)) {
                bump(stats.byBlockType, b.type);
                if (b.type === 'tool_use')
                    bump(stats.byToolName, b.name);
            }
        }
        if (r.type === 'attachment')
            bump(stats.byAttachmentType, r.attachment?.type);
        if (r.type === 'system')
            bump(stats.bySystemSubtype, r.subtype);
        if (isInputTurn(r))
            stats.inputTurns++;
        if (isToolResultRecord(r))
            stats.toolResultRecords++;
    }
    stats.sessionIds = [...sids];
    stats.agentIds = [...aids];
    stats.isSidechain = sc.size === 0 ? null : sc.size > 1 ? 'mixed' : [...sc][0];
    for (const n of nodes.values())
        if (n.children.length > 1)
            stats.branchPoints++;
    for (const g of requests) {
        stats.totalContextLoad += g.contextLoad;
        stats.totalOutputTokens += g.outputTokens;
    }
    // The live-path pointer. The last one wins: it is rewritten as the head moves.
    let liveLeafUuid = null;
    for (const r of records)
        if (r.type === 'last-prompt' && typeof r.leafUuid === 'string')
            liveLeafUuid = r.leafUuid;
    const fileKind = nodes.size > 0 ? 'transcript'
        : records.length === 0 ? 'empty'
            : records.every((r) => r.type === 'started' || r.type === 'result') ? 'journal'
                : 'unknown';
    return { fileKind, records, positions, nodes, roots, orphans, sidecars, problems, requests, toolCalls, liveLeafUuid, stats };
}
// ---- 11. Views over the tree -----------------------------------------------
/** Root to node, inclusive. The path is the conversation; the tree is everything
 *  that was ever on the way there, including what was rewound past. */
export function pathTo(t, uuid) {
    const out = [];
    let n = t.nodes.get(uuid) ?? null;
    const guard = new Set(); // a cycle cannot happen; do not hang if it does
    while (n && !guard.has(n.uuid)) {
        guard.add(n.uuid);
        out.push(n);
        n = n.parent;
    }
    return out.reverse();
}
/** The conversation as it actually stood at the end.
 *  Primary: the `last-prompt.leafUuid` pointer. Fallback: the deepest leaf,
 *  stated as a fallback because it is a GUESS and the pointer is a FACT. */
export function livePath(t) {
    if (t.liveLeafUuid && t.nodes.has(t.liveLeafUuid))
        return { path: pathTo(t, t.liveLeafUuid), from: 'leafUuid' };
    let best = null;
    for (const n of t.nodes.values()) {
        if (n.children.length)
            continue;
        if (!best || n.depth > best.depth || (n.depth === best.depth && n.index > best.index))
            best = n;
    }
    return best ? { path: pathTo(t, best.uuid), from: 'deepest-leaf' } : { path: [], from: 'none' };
}
export function repairedLivePath(t) {
    const base = livePath(t);
    const bridges = [];
    const splices = [];
    const compactions = [];
    let path = base.path;
    let extension = null;
    // (3) A STALE HEAD: the final `leafUuid` names a node that HAS CHILDREN. This happens when the
    //    last `last-prompt` record was written before the session's final exchange, which then sits
    //    below it. A leaf with children is not a leaf, so the signal is unambiguous; the path is
    //    extended to the LAST-WRITTEN descendant.
    const tip = path[path.length - 1];
    if (tip && tip.children.length) {
        let last = tip, n = 0;
        const st = [...tip.children];
        while (st.length) {
            const x = st.pop();
            n++;
            if (x.index > last.index)
                last = x;
            st.push(...x.children);
        }
        extension = { leaf: tip, to: last, records: n, kind: 'stale-head' };
        path = pathTo(t, last.uuid);
    }
    // (2) bridges and (4) compaction joins first: a truncated path has nothing above it to splice.
    //    One loop, because a segment joined across a compaction can itself start at an orphan or at
    //    an earlier boundary.
    const byIndex = [...t.nodes.values()].sort((a, b) => a.index - b.index);
    const pos = new Map(byIndex.map((n, i) => [n.uuid, i]));
    const guard = new Set();
    const logicalOf = (n) => {
        const lp = n.record.logicalParentUuid;
        return n.parentUuid === null && typeof lp === 'string' ? t.nodes.get(lp) : undefined;
    };
    while (path.length && path[0].parent === null && (path[0].parentUuid || logicalOf(path[0]))) {
        const head = path[0];
        if (guard.has(head.uuid))
            break;
        guard.add(head.uuid);
        const inPath = new Set(path.map((n) => n.uuid));
        const logical = logicalOf(head);
        if (logical) {
            const m = head.record.compactMetadata ?? {};
            const join = (to, via) => {
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
                let tip = logical;
                const st = [...logical.children];
                while (st.length) {
                    const x = st.pop();
                    if (x.index < head.index && x.index > tip.index && !inPath.has(x.uuid))
                        tip = x;
                    st.push(...x.children);
                }
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
                let tip = hd;
                const st = [...hd.children];
                while (st.length) {
                    const x = st.pop();
                    if (x.index < head.index && x.index > tip.index && !inPath.has(x.uuid))
                        tip = x;
                    st.push(...x.children);
                }
                join(tip, 'preserved-head');
                continue;
            }
            break; // neither shape: leave the path as it is, never loop
        }
        const orphan = head;
        let via;
        for (let i = (pos.get(orphan.uuid) ?? 0) - 1; i >= 0; i--)
            if (!inPath.has(byIndex[i].uuid)) {
                via = byIndex[i];
                break;
            }
        if (!via)
            break;
        bridges.push({ orphan, via, missingParent: orphan.parentUuid, kind: 'file-order' });
        path = [...pathTo(t, via.uuid), ...path];
    }
    // (1) splices: walk the path; at P -> E, insert the branch E was written after. Keyed on the
    //    SIGNATURE, not on E's type: the same shape occurs with `system:stop_hook_summary` as the
    //    late record (a Stop hook blocked stopping, the model worked on, and the summary was written
    //    at the real end) and occasionally with a user record. A genuine rewind fails the test by
    //    construction: the new prompt is LATER than everything it abandons, so nothing "runs past" it.
    const ts = (n) => String(n.record.timestamp ?? '');
    const out = [];
    for (let i = 0; i < path.length; i++) {
        const E = path[i];
        out.push(E);
        const P = path[i - 1];
        const r = E.record;
        if (!P || E.parent !== P || P.children.length < 2)
            continue;
        let last = null;
        const stack = P.children.filter((c) => c !== E);
        while (stack.length) {
            const x = stack.pop();
            if (x.index < E.index && (!last || x.index > last.index))
                last = x;
            stack.push(...x.children);
        }
        if (!last)
            continue;
        const upToP = pathTo(t, P.uuid).length;
        const branch = pathTo(t, last.uuid).slice(upToP);
        const written = branch.every((x) => x.index < E.index);
        const runsPast = branch.some((x) => ts(x) > ts(E));
        if (!branch.length || !written || !runsPast)
            continue;
        out.push(...branch);
        splices.push({ error: E, fork: P, branch, kind: 'late-write', lateType: r.type + (r.subtype ? ':' + r.subtype : '') });
    }
    return { path: out, from: base.from, bridges, splices, extension, compactions };
}
export function turnsOf(t, path) {
    const seq = path ?? livePath(t).path;
    const out = [];
    let cur = null;
    for (const n of seq) {
        if (isInputTurn(n.record)) {
            cur = { prompt: n, records: [], requests: [], toolCalls: [] };
            out.push(cur);
            continue;
        }
        if (!cur)
            continue;
        cur.records.push(n);
    }
    const reqByUuid = new Map();
    for (const g of t.requests)
        for (const r of g.records)
            reqByUuid.set(r.uuid, g);
    for (const turn of out) {
        const seen = new Set();
        for (const n of turn.records) {
            const g = reqByUuid.get(n.uuid);
            if (g && !seen.has(g)) {
                seen.add(g);
                turn.requests.push(g);
            }
        }
        const idx = new Set(turn.records.map((n) => n.index));
        turn.toolCalls = t.toolCalls.filter((c) => idx.has(c.callNode.index));
    }
    return out;
}
