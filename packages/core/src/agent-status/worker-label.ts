/** Short, lay-readable label generated beside a delegated worker task. */
export const SYSTEM = `You title a task delegated to a worker agent.

Read the delegated prompt and output ONE short title describing the worker's purpose for a non-technical user.

Rules:
- at most five words
- begin with an action verb
- name the concrete goal, not the worker or delegation
- no quotes, punctuation, markdown, JSON, or technical preamble
- never claim the task succeeded

Examples:
Audit worker lifecycle cleanup
Investigate the editor cursor
Add the missing portrait
Review context compaction thresholds`

/** Never expose the full delegated prompt while its parallel model title is still pending. */
export function fallbackWorkerLabel(prompt: string): string | undefined {
  const compact = prompt
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:please\s+|your task is to\s+|you should\s+)/i, "")
  if (!compact) return undefined
  return compact
    .split(" ")
    .slice(0, 5)
    .join(" ")
    .replace(/[.!?:;,]+$/, "")
    .slice(0, 60)
    .trimEnd()
}
