/** Short, lay-readable label generated beside a running terminal command. */
export const SYSTEM = `You label a terminal command while it is running.

Read the command and output ONE short title describing its purpose for a non-technical user.

Rules:
- at most five words
- begin with an action verb
- describe the goal, not shell syntax
- no quotes, punctuation, markdown, command names, or technical preamble
- never claim the command succeeded

Examples:
Run the focused tests
Inspect recent app errors
Find avatar image files
Check the project types`

const CODE_SHAPED = /^[{[]|<tool_call|<\|/

export function cleanCommandLabel(raw: string): string | undefined {
  const line = raw
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !CODE_SHAPED.test(entry))
  if (!line) return undefined
  const bare = line
    .replace(/^[-*•]\s+/, "")
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/[.!?:;]+$/, "")
    .trim()
  if (!/\p{L}|\p{N}/u.test(bare)) return undefined
  return bare.split(/\s+/).slice(0, 5).join(" ").slice(0, 60).trimEnd() || undefined
}
