export * as SessionCompactionArchive from "./compaction-archive"

import { KbChunk } from "../kb-graph/chunk"
import { SessionCompaction } from "./compaction"
import type { SessionMessage } from "./message"

// Where a conversation GOES when it is compacted (owner, 2026-08-21).
//
// 🔴 **One chat per colleague means the chat never ends, so compaction is not a tidy-up — it is the
// only moment the older half of a colleague's working life stops being reachable.** The summary that
// compaction writes is a paragraph; the conversation it replaced was hours. Keeping only the summary
// is how a colleague comes to say "I don't have that in front of me" about work it did last week.
//
// So at compaction the compressed-away transcript is written into the colleague's OWN memory scope
// as passages — the same substrate `kb ingest` uses. Nothing new is invented for the agent to learn:
// `kb search` already finds passages, ranks them, and returns them by id, which is exactly "locate
// it and datamine it when recall is not enough".
//
// ⚠️ **Passages, not a blob.** A chunked, embedded passage is reachable by meaning; a stored
// transcript file is reachable only by someone who already knows it exists. The message rows stay in
// the database either way — this is not a second copy of the truth, it is the only copy the agent
// can actually search.

/** Whether this colleague archives its compacted conversations. */
export const shouldArchive = (input: {
  readonly memory: "own" | "none" | undefined
  readonly archiveChats: boolean | undefined
}): boolean => {
  // A throwaway keeps nothing, and that is the whole point of it — archiving would hand "Crashtest
  // Joe" a memory by the back door, which is exactly what a probe must not have.
  if (input.memory === "none") return false
  // Default ON: the owner's rule is "unless the officer's settings disable it".
  return input.archiveChats !== false
}

/** The label every passage from one compaction carries — what the reader sees beside the text.
 *
 *  ⚠️ Names the CHAT and the DAY, never the compaction. "Bookkeeping · 2026-08-21" is something a
 *  colleague can recognise months later; "compaction 7 of ses_f3d…" is a database fact wearing a
 *  label. The date is deliberately coarse: a passage is not an event, and a timestamp to the second
 *  invites a reader to treat it as one. */
export const archiveLabel = (input: { readonly title: string | undefined; readonly at: Date }): string => {
  const day = input.at.toISOString().slice(0, 10)
  const title = input.title?.trim()
  return title ? `${title} · ${day}` : `Chat · ${day}`
}

/** Does this serialized line carry anything a reader could use?
 *
 *  ⚠️ Not `length > 0`. `serializeMessage` prefixes a SPEAKER LABEL, so a blank message comes back as
 *  `"[User]:    "` — eleven characters of nothing, which then chunk into a passage that says nothing
 *  and still ranks in a search. The label is stripped before the emptiness is judged. */
const hasContent = (line: string): boolean => line.replace(/^\[[^\]]*\]:?\s*/, "").trim() !== ""

export interface ArchivePassage {
  readonly id: string
  readonly text: string
  readonly label: string
}

/**
 * The passages to write for one compaction cycle.
 *
 * ⚠️ **Re-ingesting the same text is HARMLESS and expected.** The id is derived from the label and
 * the text (`KbChunk.passageID`), and the engine dedupes by primary key — measured in `tool/kb.ts`.
 * That is what lets this run on every compaction without tracking which messages were already
 * archived: the overlap between two cycles collapses into the same rows rather than accumulating a
 * second copy of the same afternoon.
 */
export const plan = (input: {
  readonly messages: readonly SessionMessage.Message[]
  readonly title: string | undefined
  readonly at: Date
}): readonly ArchivePassage[] => {
  const label = archiveLabel({ title: input.title, at: input.at })
  const transcript = input.messages
    // A compaction message is a SUMMARY of what is already being archived here. Including it would
    // put a paraphrase in the same scope as the thing it paraphrases, and a search would then return
    // both — the second one looking like independent corroboration of the first.
    .filter((message) => message.type !== "compaction")
    .map((message) => SessionCompaction.serializeMessage(message))
    .filter((text) => hasContent(text))
    .join("\n\n")
  if (transcript.trim() === "") return []
  return KbChunk.chunk(transcript).map((text) => ({ id: KbChunk.passageID(label, text), text, label }))
}
