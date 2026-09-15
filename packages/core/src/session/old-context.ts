export * as OldContext from "./old-context"

import fs from "node:fs/promises"
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
 * ⚠️ **`save` lives here, next to `name`, and that is the whole design.** The name and the write are
 * one decision: a caller that builds a path and then picks its own write flags can produce a tombstone
 * naming a file the harness refused to create, or appended to a previous fold instead of replacing it.
 * The two wrong flags are both plausible and both silent — `wx` fails the write that the tombstone has
 * already promised, `a` grows a file whose name says it holds one conversation. So no caller gets to
 * choose: `save` owns `mkdir -p` and owns the flag, and the only path in the tree that produces this
 * filename is the one that just wrote it.
 */

/** Inside the agent's scratch folder, beside its other throwaway work. */
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

/**
 * Write the folded chat to its own name, creating the folder on the way if it is not there.
 *
 * ⚠️ **`mkdir` is recursive and idempotent on purpose.** The agent's scratch folder is normally
 * created when the colleague is, but nothing guarantees it: the folder can be deleted under a running
 * instance, a colleague can be reached before its own provisioning ran, and the harness must not
 * answer either with a missing tombstone. Creating `tmp/` — and the agent folder above it, if that is
 * what is missing — is the difference between "the agent can still read its earlier chat" and "the
 * write threw and the context says nothing". It is one syscall against a folder that already exists
 * in the common case.
 *
 * ⚠️ **The flag is `w`, stated rather than defaulted, and it is the third decision here.** An existing
 * file at this exact name is a real possibility, not a hypothetical: the stamp is millisecond
 * resolution, two folds can land in the same millisecond under load, and the wall clock can step
 * *backwards* — a corrected NTP sync, a resumed VM, a laptop waking from sleep — so a NEW fold can
 * produce an OLDER name. In every one of those cases the harness must replace the file and carry on.
 * `wx` would turn a name collision into a failed compaction over a convenience file; `a` would leave
 * the newest fold appended under a name that names one conversation, and an agent that greps it would
 * read two folds glued together with nothing marking the seam. Replacing loses the older file, which
 * is the honest outcome: its content was already folded into a summary that is still in that older
 * context, and a tombstone in a LATER context always names the file that fold wrote.
 *
 * The returned path is the one that was written — the caller names what this function did, never what
 * it intended to do.
 */
export const save = async (input: {
  readonly scratchFolder: string
  readonly at: Date
  readonly text: string
}): Promise<string> => {
  const target = file({ scratchFolder: input.scratchFolder, at: input.at })
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, input.text, { encoding: "utf8", flag: "w" })
  return target
}
