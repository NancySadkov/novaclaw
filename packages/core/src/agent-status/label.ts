/**
 * The line Contacts shows under a colleague's name.
 *
 * 🔴 This is NOT the retired session title, and the difference is the whole feature. A title named a
 * conversation so the user could find it again — written once, from the FIRST thing said, and never
 * revisited. This answers *"what is this colleague doing right now?"*, from the newest work, and it
 * is rewritten as the work moves on. Same shape of model call, opposite question.
 */

/** Hard ceiling on the stored line. Contacts renders one row per colleague; two lines is a list. */
export const MAX_LABEL = 60

export const SYSTEM = `You report what a colleague is working on, for a contacts list.

<task>
Read the recent activity and output ONE short line naming the CURRENT task.

Your output must be:
- A single line
- At most ${MAX_LABEL} characters
- A task, not a summary of the conversation
- Present tense, no subject: "reviewing the P2P handshake", not "The agent is reviewing..."
</task>

<rules>
- use the same language as the user
- name WHAT is being worked on, concretely — a file, a subsystem, a question
- never name tools ("read tool", "bash"), model names, or session ids
- never invent work that is not in the activity
- if the activity shows the work FINISHED, say what was finished: "finished the auth migration"
- no trailing period, no quotes, no markdown
</rules>

<examples>
reviewing the P2P handshake
fixing flaky calendar tests
finished the auth migration
waiting on the user's answer about scope
</examples>`

// Same defence the titler needs, for the same reason: a model that echoes its seed produces a
// "status" that is a fragment of a tool call. A contacts row is prose or it is nothing.
const CODE_SHAPED = /^[{[]|\(\{|<tool_call|<\|/

/**
 * Normalise raw model output into a status line, or `undefined` when nothing usable remains.
 *
 * ⚠️ `undefined` rather than a fallback string. The pass simply leaves the previous line in place
 * and tries again next interval — a colleague showing slightly stale work is honest, while one
 * showing "Unknown" or an empty row has been given words it never said.
 */
export function clean(raw: string): string | undefined {
  const line = raw
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !CODE_SHAPED.test(entry))
  if (!line) return undefined
  // Strip the wrappers a model reaches for when asked for one line: quotes, a leading bullet, a
  // trailing full stop. Each of them is noise in a 60-character row.
  const bare = line
    .replace(/^[-*•]\s+/, "")
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/\.$/, "")
    .trim()
  /**
   * ⚠️ Must contain an actual WORD, not merely be non-empty. Stripping one quote from each end of
   * `"""` leaves `"`, which is truthy and would have reached Contacts as a status line consisting of
   * a punctuation mark. "Not empty" is the wrong test for "is this a sentence".
   */
  if (!/\p{L}|\p{N}/u.test(bare)) return undefined
  return bare.length > MAX_LABEL ? `${bare.slice(0, MAX_LABEL - 1).trimEnd()}…` : bare
}
