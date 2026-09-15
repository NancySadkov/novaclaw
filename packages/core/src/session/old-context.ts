export * as OldContext from "./old-context"

import fs from "node:fs/promises"
import path from "node:path"
import type { Message, SystemPart } from "@novaclaw/llm"
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
 * The marker that says "this system part is the tombstone, not part of the prompt's shape".
 *
 * 🔴 **Measured 2026-09-15, and it is the whole reason this exists.** `PromptEstimate.resolve` matches
 * its durable provider anchor by `shapeKey(request)`, and that key hashes `{system, tools, ...}` — so a
 * tombstone appended to the system prompt changed the key, the anchor was rejected as `shape-changed`,
 * the estimate fell back to the raw heuristic, and the dispatch gate refused a chat the provider had
 * already counted at 8,000 against a 20,000 ceiling. The turn then folded a conversation that did not
 * need folding. A one-line tombstone poisoning the anchor on the very turn it appears — and on the next
 * one, because the anchor is recorded from the request that was sent — is a regression of exactly the
 * failure (`ses_geryon`, 229,614 against 229,376) this clause was written to fix.
 *
 * The marker rides `metadata`, which the wire never reads: every protocol lowers system parts through
 * `joinText`, which reads `part.text` only.
 */
export const MARKER = "novaclaw.oldContext"

/** The system part for the tombstone: the line, marked so the shape key can ignore it. */
export const part = (file: string): SystemPart => ({
  type: "text",
  text: tombstone(file),
  metadata: { [MARKER]: true },
})

/** Is this system part the tombstone? True only for parts built by `part`. */
export const isTombstone = (part: SystemPart): boolean => part.metadata?.[MARKER] === true

/**
 * The cut text, as text — because the tombstone's promise is that the agent can *grep* it.
 *
 * `invariants.md` (Context Management 2): *"we store the cut text in the agent's scratch, so that
 * agent can still grep it."* That is the acceptance test for this function, and it is stricter than
 * "the file has content": a message body has to survive verbatim and on its own line, or the grep
 * finds nothing and the promise was decoration.
 *
 * ⚠️ **It renders the LLM messages that actually left, not the session entries they came from.**
 * Those are two different texts — the wire form has already been demoted, elided, trimmed and
 * tool-repaired by the packer's own passes — and a file claiming to hold "the context that was cut"
 * must hold the bytes that were cut, not a reconstruction that is close. Joining back to entries is
 * also a second lookup that can disagree with the drop set; this cannot, because it is handed the drop
 * set.
 *
 * The labels are the same `[role]:` shape the summarizer's transcript uses, so an agent reading this
 * file reads the vocabulary it already knows from compaction. Tool calls and results keep their ids:
 * a tool result without its call is an answer to nothing, and the id is the join the agent needs to
 * reconstruct which of its own actions produced it.
 */
export const render = (messages: ReadonlyArray<Message>): string => messages.map(renderMessage).join("\n\n")

const renderPart = (part: Message["content"][number]): string => {
  switch (part.type) {
    case "text":
      return part.text
    case "reasoning":
      return `[reasoning]\n${part.text}`
    case "media":
      return `[image ${part.mediaType}${part.filename === undefined ? "" : ` ${part.filename}`}]`
    case "tool-call":
      return `[tool call ${part.name} id=${part.id}]\n${stringify(part.input)}`
    case "tool-result":
      return `[tool result ${part.name} id=${part.id}]\n${renderResultValue(part.result)}`
    default:
      return `[${(part as { readonly type: string }).type}]`
  }
}

const renderResultValue = (result: { readonly type: string; readonly value: unknown }): string => {
  // `content` is the only structured arm (text/file blocks); every other arm already carries the
  // value the tool returned, and `stringify` renders it without inventing a shape.
  if (result.type !== "content" || !Array.isArray(result.value)) return stringify(result.value)
  return result.value
    .map((block: unknown) => {
      const record = block as { readonly type?: string; readonly text?: string; readonly mime?: string }
      if (record?.type === "text" && typeof record.text === "string") return record.text
      return `[${record?.type ?? "block"}${record?.mime === undefined ? "" : ` ${record.mime}`}]`
    })
    .join("\n")
}

const renderMessage = (message: Message): string => `[${message.role}]:\n${message.content.map(renderPart).join("\n")}`

const stringify = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, undefined, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

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
