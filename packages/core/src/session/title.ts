export * as SessionTitle from "./title"

// Auto-title (owner directive): generate the session title right AFTER the model's response
// settles — the user is busy reading it, so the extra model call costs no perceived wall-clock —
// because the title grounds BOTH the user (the chat list) and the model across compactions (the
// title survives them). Pure helpers here; the runner owns the model call and the row patch.

import { STEER_PROVENANCE_PREFIX } from "./input"
import type { SessionMessage } from "./message"

/** The title-generator system prompt (ported from the V1 `title` agent's `title.txt`). */
export const SYSTEM = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- ≤50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  → create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" → Debugging production 500 errors
"refactor user service" → Refactoring user service
"why is app.js failing" → app.js failure investigation
"implement rate limiting" → Rate limiting implementation
"how do I connect postgres to my API" → Postgres API connection
"best practices for React hooks" → React hooks best practices
"@src/auth.ts can you add refresh token support" → Auth refresh token support
"@utils/parser.ts this is broken" → Parser bug fix
"look at @config.json" → Config review
"@App.tsx add dark mode toggle" → Dark mode toggle in App
</examples>`

// The core default is now the bare `New session` (a raw ISO timestamp in the chat header is
// machine noise to a lay user — the list already shows relative time). The older ISO-suffixed
// forms (`New session - <ISO>`, legacy V1 `Child session - <ISO>`) still count so sessions
// created before the change keep auto-titling away.
const DEFAULT_TITLE_REGEX =
  /^(New session|Child session)( - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/

/** True while the title is still a creation default — the only state auto-title may replace. */
export function isDefault(title: string): boolean {
  return DEFAULT_TITLE_REGEX.test(title)
}

/**
 * The text of the first REAL user message: harness steers are stored as `user` messages too
 * but always carry the 1N provenance prefix, so they never seed a title.
 */
export function firstRealUserText(context: readonly SessionMessage.Message[]): string | undefined {
  for (const message of context) {
    if (message.type !== "user") continue
    if (message.text.startsWith(STEER_PROVENANCE_PREFIX)) continue
    const text = message.text.trim()
    if (text) return text
  }
  return undefined
}

/** V1-parity forked-session title: "X (fork #N)" increments N; anything else gains "(fork #1)". */
export function forked(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) return `${match[1]} (fork #${parseInt(match[2], 10) + 1})`
  return `${title} (fork #1)`
}

// A chat name must read like prose, never code: a titler echoing its seed produced the live
// title `define_tool({"name": "greet_probe", …` (issues.md P3). Reject JSON openers, call
// syntax with an object argument, tool-call tags, and leaked template special tokens.
const CODE_SHAPED = /^[{[]|\(\{|<tool_call|<\|/

/**
 * Normalize raw model output into a usable title (V1 parity): drop `<think>` blocks, take the
 * first non-empty line that doesn't look like code, cap at 100 characters. Returns undefined
 * when nothing usable remains (the titler simply retries at the next drain end).
 */
export function clean(raw: string): string | undefined {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !CODE_SHAPED.test(line))
  if (!cleaned) return undefined
  return cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
}
