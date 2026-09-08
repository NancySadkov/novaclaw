/**
 * The staged-revert VIEW — one module answering the four questions a staged revert raises, because
 * they must answer consistently and, when each caller derived its own answer, they diverged.
 *
 *   1. what does the transcript still SHOW?          `selectVisibleMessages`
 *   2. what did the revert ROLL BACK (the dock)?     `selectRolledMessages`
 *   3. where must a `revert.commit` be ANCHORED?     `commitBoundaryID`
 *   4. which message does `/undo` / `/redo` move to? `undoTargetID` / `nextMessageID`
 *
 * (1) and (2) are exact complements of one another by construction — `pinnedPartition` in the
 * tests asserts it — so the dock can never name a message the transcript is still drawing, which
 * is the shape of the bug reported twice (owner, 2026-07-28 / 2026-07-29).
 *
 * ⚠️ INDEX-FIRST, never a bare id compare. Message ids sort ascending only when the APP minted
 * them (`msg_fab7060160010s31FhIt13gZGs`); `<` against anything else is meaningless — a probe or a
 * test seeded with hand-written ids like `msg_probe1` sorts ABOVE every generated id and makes any
 * ordering assertion vacuous (that trap invalidated a whole diagnosis on 2026-07-29). Every
 * function here locates the boundary by IDENTITY in the already-ordered list and falls back to the
 * lexicographic compare only when the boundary is not present at all — e.g. it sits in a page
 * history has not loaded yet, where position is genuinely unknown.
 */

/**
 * "Before everything" commit boundary — the client mirror of `SessionRevert.BEFORE_ALL`
 * (`packages/core/src/session/revert.ts`). Declared here rather than imported because that module
 * pulls in drizzle and the Database service, which the renderer must never load.
 */
export const BEFORE_ALL = "msg_"

const EMPTY: readonly never[] = []

/**
 * The messages a staged revert leaves on screen: everything strictly BEFORE the boundary. The
 * boundary message itself is rolled back — `revert.stage` points at the user message whose turn is
 * being undone, so that message and its assistant reply both go.
 */
export function selectVisibleMessages<T extends { id: string }>(
  messages: readonly T[],
  revertMessageID?: string,
): readonly T[] {
  if (!revertMessageID) return messages
  const index = messages.findIndex((message) => message.id === revertMessageID)
  if (index === 0) return EMPTY as readonly T[]
  if (index > 0) return messages.slice(0, index)
  return messages.filter((message) => message.id < revertMessageID)
}

/**
 * The exact complement of {@link selectVisibleMessages}: the boundary message and everything after
 * it. This is what the revert dock names, and what Discard deletes.
 */
export function selectRolledMessages<T extends { id: string }>(
  messages: readonly T[],
  revertMessageID?: string,
): readonly T[] {
  if (!revertMessageID) return EMPTY as readonly T[]
  const index = messages.findIndex((message) => message.id === revertMessageID)
  if (index === 0) return messages
  if (index > 0) return messages.slice(index)
  return messages.filter((message) => message.id >= revertMessageID)
}

/**
 * The id to pass to `revert.commit` so that `targetID` **and everything after it** is deleted.
 *
 * ⚠️ Pass the FULL message list, not just the user messages. `commit` deletes by row `seq`
 * (`session/projector.ts`, the `RevertEvent.Committed` arm: `seq > boundary.seq`), so anchoring on
 * the previous USER message also destroys the assistant reply that sits between the two — one
 * message more than the user asked to discard, and it is not recoverable.
 *
 * Initial agent/model switch records are setup state, not a visible predecessor: when they are the
 * entire prefix before the first prompt this returns BEFORE_ALL. Returns `undefined` when `targetID`
 * is not in the list, so a caller cannot accidentally commit against a boundary it could not locate.
 */
export function commitBoundaryID(messages: readonly { id: string }[], targetID: string): string | undefined {
  const index = messages.findIndex((message) => message.id === targetID)
  if (index < 0) return undefined
  // A session begins with agent/model selection records. They are setup state, not a visible turn:
  // when they are the ONLY predecessors of the first prompt, keeping the last one makes "revert the
  // first message" leave a phantom row behind. Mid-conversation switches still count as real history
  // because at least one non-switch message precedes them.
  const prefix = messages.slice(0, index) as readonly { id: string; type?: string }[]
  if (
    prefix.length > 0 &&
    prefix.every((message) => message.type === "agent-switched" || message.type === "model-switched")
  )
    return BEFORE_ALL
  return messages[index - 1]?.id ?? BEFORE_ALL
}

/** The message immediately after `afterID`, or `undefined` when it is the last one. */
export function nextMessageID(messages: readonly { id: string }[], afterID: string): string | undefined {
  const index = messages.findIndex((message) => message.id === afterID)
  if (index >= 0) return messages[index + 1]?.id
  return messages.find((message) => message.id > afterID)?.id
}

/**
 * Where `/undo` moves the boundary to: the last user message still visible. Undefined means there
 * is nothing left to undo (the boundary is already at the first prompt).
 */
export function undoTargetID(users: readonly { id: string }[], revertMessageID?: string): string | undefined {
  return selectVisibleMessages(users, revertMessageID).at(-1)?.id
}
