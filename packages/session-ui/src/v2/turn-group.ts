// Grouping the flat transcript into TURNS — the container the "Done" fold needs.
//
// Owner ruling 2026-08-11: a settled turn should read as the answer, with the machinery that
// produced it folded away for whoever wants to open the hood. The transcript cannot do that today
// because it has no turn: `NativeTranscript` renders assistant steps, tool parts, harness nudges,
// shell rows and notices as flat siblings, and one turn spans SEVERAL assistant messages. There is
// nothing to collapse. This module supplies the missing entity, kept pure so the boundary rules —
// which are the whole difficulty — are testable without a DOM.

/** One user prompt and everything the agent produced in response. */
export interface TurnGroup<T> {
  /**
   * The prompt that opened the turn. `undefined` only for a leading group: a session resumed
   * mid-flight, or an agent-initiated (scheduled, spawned, messenger-driven) session whose first
   * words are the agent's own.
   */
  readonly lead: T | undefined
  /** The response, in transcript order — assistant steps, notices, shell rows, compactions. */
  readonly body: readonly T[]
}

/**
 * Split a flat transcript into turns.
 *
 * ⚠️ **A harness steer is a `user` message and must NOT open a turn.** Doom-loop redirects,
 * affective nudges and denial redirects reach the model on the user role, so a naive
 * `type === "user"` split cuts one turn into several and strands the answer in a group of its own.
 * The caller supplies the predicate because only it can tell the two apart (the 1N provenance
 * prefix), and getting this wrong is invisible until a turn happens to be nudged.
 */
export function groupTurns<T>(messages: readonly T[], isTurnStart: (message: T) => boolean): readonly TurnGroup<T>[] {
  const groups: TurnGroup<T>[] = []
  let lead: T | undefined
  let body: T[] = []
  let started = false
  for (const message of messages) {
    if (isTurnStart(message)) {
      if (started || body.length > 0) groups.push({ lead, body })
      lead = message
      body = []
      started = true
      continue
    }
    body.push(message)
  }
  if (started || body.length > 0) groups.push({ lead, body })
  return groups
}

/** The minimum an assistant content part must expose for the answer split. */
export interface AnswerPart {
  readonly type: string
  readonly text?: string
}

/**
 * Where the ANSWER starts inside an assistant message's content — the index of the first part of
 * the trailing run of prose.
 *
 * Everything before it is work: tool calls, reasoning, and the narration between them ("Now I'll
 * check the tests…"), which reads as progress while it streams and as noise once the turn is over.
 * Returns `content.length` when the message ends on a tool call or reasoning — an interrupted or
 * still-running step has no answer yet, and the caller must not fold a turn that has nothing to
 * show in its place.
 */
export function answerStart(content: readonly AnswerPart[]): number {
  let start = content.length
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i]!
    if (part.type === "text") {
      // A trailing empty text part is a streaming artifact, not prose — skip it without letting it
      // terminate the run, or a turn whose last delta arrived empty would fold its own answer away.
      if ((part.text ?? "").trim() !== "") start = i
      continue
    }
    break
  }
  return start
}

/**
 * Reuse the previous group objects wherever nothing in them changed.
 *
 * 🔴 **The scroll jump (owner, 2026-08-11): "after tool use the chat view gets scrolled to the top,
 * despite it being positioned at the bottom".** Solid's `<For>` keys by REFERENCE, and `groupTurns`
 * builds fresh `{lead, body}` objects on every recompute — so any event that touches a message (a
 * tool result landing, a streamed delta) produced an all-new array and `<For>` destroyed and rebuilt
 * EVERY turn. The transcript's height collapses during that teardown, the browser clamps `scrollTop`
 * to the smaller `scrollHeight`, and the user is at the top.
 *
 * ⚠️ The auto-scroll could not save it. The timeline re-sticks on `messages().length`, and a tool
 * result does not change the length — it mutates a message already in the list. So the one signal
 * that would have re-pinned never fired.
 *
 * Identity is compared on the MESSAGE OBJECTS, not on their ids. Store rows are reference-stable
 * while they mutate, but a reconcile can REPLACE a row with a fresh object carrying the same id —
 * matching on ids would then hand `<Turn>` a stale object and freeze that turn's render.
 */
export function stableGroups<T>(
  previous: readonly TurnGroup<T>[],
  next: readonly TurnGroup<T>[],
): readonly TurnGroup<T>[] {
  let changed = previous.length !== next.length
  const out = next.map((group, index) => {
    const old = previous[index]
    if (
      old !== undefined &&
      old.lead === group.lead &&
      old.body.length === group.body.length &&
      old.body.every((message, i) => message === group.body[i])
    )
      return old
    changed = true
    return group
  })
  // Hand back the SAME array when nothing moved, so a `createMemo` wrapping this can bail out too.
  return changed ? out : previous
}

/**
 * Should the turn render FOLDED, and if so which closing assistant message does the fold render?
 *
 * 🔴 **Returns the message rather than a boolean, and that is the whole point.** The folded branch is
 * built around the turn's closing assistant message — it renders it twice, as the `work` half inside
 * Done and the `answer` half outside. A boolean gate let the branch be entered without one, and the
 * JSX papered over it with `closing()!`.
 *
 * That crashed a shipped 0.1.67 renderer mid-conversation and took the ENTIRE app down with it
 * (`TypeError: Cannot read properties of undefined (reading 'time')`, out of a `<Show>`'s `when`,
 * through the app's single root ErrorBoundary). The state is ordinary, not exotic: a settled turn
 * whose last row is a tool call rather than prose. `hasAnswer` is then false, so `outcome` supplies
 * its stand-in and satisfies that clause; `hasWork` needs only a second row; and `running` goes false
 * the instant the turn settles. Measured live in `ses_fbc4201ceffe…` at `session.finish`.
 *
 * ⚠️ **The RETURN TYPE is the fix, not a guard clause inside it.** Nothing here could be written as
 * an assertion that fails loudly: a boolean gate and this one agree on every input — they differ only
 * in what the caller can do afterwards. Returning `T | undefined` forces the fold behind a bound
 * `<Show>`, so the branch cannot be entered without its message; a boolean left the caller free to
 * reach for `closing()!` and it did. No unit test can catch the regression either, because the
 * defect lives in the JSX, not in this function — reintroducing `!` would still compile.
 */
export function foldClosing<T>(input: {
  readonly closing: T | undefined
  readonly running: boolean
  readonly hasWork: boolean
  readonly hasAnswer: boolean
  readonly outcome: unknown
}): T | undefined {
  if (input.closing === undefined) return undefined
  if (input.running || !input.hasWork) return undefined
  if (!input.hasAnswer && input.outcome === undefined) return undefined
  return input.closing
}
