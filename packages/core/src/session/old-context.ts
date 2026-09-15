import path from "node:path"
import { stampOf } from "../observability/log-file"

/**
 * The folded-away conversation, written where the agent can still reach it.
 *
 * `invariants.md` (Context Management) names this mechanism twice. Clause 1: normal compaction
 * "prepend[s] its result with our system prompt, agent's identity and `<tombstone>`:
 * `%AGENT_SCRATCH_FOLDER%/tmp/oldctx-%DATETIME%.txt holds earlier chat`". Clause 2: deterministic
 * compaction "chops the head of the context, stores it to the agent's scratch folder, and prepends a
 * tombstone naming the file".
 *
 * 🔴 **Nothing wrote that file.** Measured 2026-09-15: the string `oldctx` did not exist anywhere in
 * `packages/`, and the folded text went to the KB as searchable passages instead. Those answer
 * different questions — the KB is *recall*, by meaning, and only if the agent thinks to ask; this is
 * the *transcript*, at a path the agent was handed, which it can grep, quote and diff. A compaction
 * that cannot be interrogated is a compaction the agent has to take on faith.
 *
 * PURE, deliberately. The name and the tombstone are decisions a test can hold still, and the write
 * itself stays at the caller — the same split `script/lib/arguments.ts` uses, for the same reason: the
 * side-effecting half is the one a test cannot call. That is also why this file has no `write` in it
 * and no `Effect`.
 */
export const DIR = "tmp"

/** `oldctx-20260915T174500123Z.txt`. The stamp form the log segments already use, so it sorts. */
export const name = (at: Date): string => `oldctx-${stampOf(at)}.txt`

/** `<agent scratch>/tmp/oldctx-<DATETIME>.txt` — the path the invariant spells, built in one place. */
export const file = (input: { readonly scratchFolder: string; readonly at: Date }): string =>
  path.join(input.scratchFolder, DIR, name(input.at))

/**
 * The line that goes into the compacted context, naming the file the folded text landed in.
 *
 * It is prepended to the summary rather than buried in it: an agent that cannot see the earlier chat
 * must be told, in the place it looks, that the chat is not gone. `file` is absolute, because the
 * agent's working directory is not necessarily its scratch folder.
 */
export const tombstone = (file: string): string => `${file} holds earlier chat`
