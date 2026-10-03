export * as NudgeDefinition from "./nudge-definition"

import type { ConfigNudge } from "./config/nudge"

export const LOW_RESOURCE_ID = "builtin-low-resources"
export const JAVASCRIPT_TIME_ID = "builtin-javascript-time-safety"
export const NEW_DAY_ID = "builtin-new-day"
export const BLOATED_TODO_ID = "builtin-bloated-todo"
export const DOOM_LOOP_ID = "builtin-doom-loop"
export const FAILURE_STREAK_ID = "builtin-failure-streak"
export const SESSION_RESTART_ID = "builtin-session-restart"
export const EMPTY_TURN_ID = "builtin-empty-turn"
export const ANNOUNCED_TOOL_ID = "builtin-announced-tool"
export const FINISH_AUDIT_ID = "builtin-finish-audit"
export const DELEGATE_CHECK_ID = "builtin-delegate-check"
export const PROJECT_OPTIMIZATION_ID = "builtin-project-optimization"
export const PROJECT_CLEANUP_ID = "builtin-project-cleanup"
export const STEP_REASONING_ID = "builtin-step-reasoning"
export const STEP_TOOL_ID = "builtin-step-tool"
export const STEP_ANSWER_ID = "builtin-step-answer"

export const defaults = (): ReadonlyArray<ConfigNudge.Info> => [
  {
    id: LOW_RESOURCE_ID,
    name: "Protect work when resources run low",
    enabled: true,
    default: true,
    hook: { type: "resource-pressure", level: "either" },
    text:
      "This instance is low on memory or disk headroom. Avoid starting memory- or disk-intensive work. " +
      "Use tool_search for resource status, then resource_status for the live figures and confirm recovery before resuming heavy work.",
  },
  {
    id: JAVASCRIPT_TIME_ID,
    name: "Check JavaScript time conversions",
    enabled: true,
    default: true,
    /**
     * 🔴 `write-match`, not `text-match`. This nudge's text tells the agent it "is editing
     * JavaScript/TypeScript time code", and only a writing tool can make that true. A `text-match`
     * hook is tested against the INPUT and the OUTPUT of EVERY tool call, so it fired when the agent
     * was reading a file that happened to contain timestamp arithmetic, and when a shell one-liner
     * merely formatted a column with `new Date(row.time_created)` — twice on 2026-09-12, once in the
     * owner's own session. Measured, not assumed: the two post-fix deliveries in
     * `session_nudge_delivery` on this instance were a `bash` call and a `read` call.
     */
    hook: {
      type: "write-match",
      pattern:
        "(?:[-+]\\s*(?:(?:[\\w$]+\\.)*time\\.(?:created|completed)|createdAt|completedAt|startedAt|endedAt)|(?:(?:[\\w$]+\\.)*time\\.(?:created|completed)|createdAt|completedAt|startedAt|endedAt)\\s*[-+]|new\\s+Date\\([^)]*(?:created|completed|started|ended|timestamp))",
    },
    text: "You are editing JavaScript/TypeScript time code. Before continuing, verify every value's runtime shape at its transport/schema boundary and normalize it before subtraction or formatting. Guard non-finite results so an invalid conversion can never render NaN.",
  },
  {
    id: BLOATED_TODO_ID,
    name: "Trim bloated todo and Markdown files",
    enabled: true,
    default: true,
    hook: {
      type: "javascript",
      code: 'file.sizeBytes > 50 * 1024 && (file.path.toLowerCase().includes("todo") || file.path.toLowerCase().endsWith(".md"))',
    },
    text: "Bloated - reduce $(absolute_file_path) to 40kb, remove completed items and cruft, use simple direct concise language.",
    spammable: true,
  },
  {
    id: NEW_DAY_ID,
    name: "A new day begins",
    enabled: true,
    default: true,
    hook: { type: "new-day" },
    text: "Today is $(date '+%Y-%m-%d %A').",
  },
  {
    id: DOOM_LOOP_ID,
    name: "Break a repeating tool loop",
    enabled: true,
    default: true,
    hook: { type: "repeated-tool", tool: "bash", count: 3, kind: "identical" },
    text: "Last 3 bash calls got same result. Don't loop - do better. Now is $(date '+%Y-%m-%d %A %H:%M:%S').",
  },
  {
    id: FAILURE_STREAK_ID,
    name: "Break a failing tool streak",
    enabled: true,
    default: true,
    hook: { type: "repeated-tool", count: 3, kind: "failure" },
    text:
      "The last few tool calls to the same target failed the same way. Stop repeating it — read the " +
      "error, change your approach, or tell the user what's blocking you.",
  },
  {
    id: SESSION_RESTART_ID,
    name: "Session restarted",
    enabled: true,
    default: true,
    hook: { type: "session-restarted" },
    text: "Session restarted. Recover and proceed.",
  },
  {
    id: EMPTY_TURN_ID,
    name: "Recover from an empty turn",
    enabled: true,
    default: true,
    hook: { type: "empty-turn", count: 1 },
    text:
      "Your last turn ended with no reply and no tool call. If you meant to call a tool and it did not " +
      "run, issue it again now as a proper tool call. Otherwise finish with a short, verified summary.",
  },
  {
    id: ANNOUNCED_TOOL_ID,
    name: "Recover an announced tool call",
    enabled: true,
    default: true,
    hook: { type: "announced-tool" },
    text:
      "Your last turn said what you were about to do but did not actually call a tool, so nothing ran. " +
      "Issue that tool call now as a real tool call — do not describe it, and do not restate the plan.",
  },
  {
    id: FINISH_AUDIT_ID,
    name: "Continue after finish audit",
    enabled: true,
    default: true,
    hook: { type: "finish-audit" },
    text:
      "Your exit request was reviewed and the requested work is not finished. Continue now with one " +
      "concrete next action. Use tools when needed, and do not stop at a plan or progress note.",
  },
  {
    id: DELEGATE_CHECK_ID,
    name: "Delegate substantial work",
    enabled: true,
    default: true,
    hook: { type: "interval", minutes: 60 },
    minSubordinates: 1,
    tokenRate: { tokens: 20_000, windowSeconds: 3_600 },
    text: "What are you doing right now? Is this related to your explicit job instructions? If it is substantial work - delegate it.",
  },
  {
    id: PROJECT_OPTIMIZATION_ID,
    name: "Project optimization",
    enabled: true,
    default: true,
    hook: { type: "interval", minutes: 1_440 },
    minSubordinates: 1,
    text:
      "Review the current work on the project, then optimize the workflow where possible: eliminate " +
      "progress blocking issues, recuce friction; create/install missing tools.",
  },
  {
    id: PROJECT_CLEANUP_ID,
    name: "Project cleanup",
    enabled: true,
    default: true,
    hook: { type: "interval", minutes: 4_320 },
    minSubordinates: 1,
    requireTmpFolder: true,
    text:
      "1. Clean up all files in ./tmp, older than 3 days.\n" +
      "2. Move files from ./attic to ./tmp\n" +
      "3. Review project files, then move the obsolete/temporary/unrelated-to-project files to ./attic.",
  },
  // ── Step budgets ────────────────────────────────────────────────────────────────────────────────
  //
  // Officer parity for the reasoning controller: a reasoning budget exists, but nothing bounded a
  // single step's ANSWER, so a runaway reply (or a tool call with a body the size of a file) had no
  // backstop at all. These three are that backstop, and they are nudges rather than `max_tokens`
  // caps on purpose: a cap truncates mid-sentence and a thinking model truncated inside its think
  // block returns NOTHING, while a nudge lets the step finish and asks for a conclusion. The
  // threshold is per STEP, so a long session that answers briefly every turn is never touched.
  {
    id: STEP_REASONING_ID,
    name: "Break a repeating reasoning loop",
    enabled: true,
    default: true,
    hook: { type: "step-tokens", channel: "reasoning", tokens: 8_000 },
    text:
      "This one step has spent a very large amount of reasoning and started repeating itself. Stop " +
      "re-deriving: state the best conclusion you have, then act on it or answer.",
  },
  {
    id: STEP_TOOL_ID,
    name: "End a step with an oversized tool call",
    enabled: true,
    default: true,
    hook: { type: "step-tokens", channel: "tool", tokens: 8_000 },
    text:
      "This step is producing an extremely large tool call. Stop and end the step: make a smaller, " +
      "targeted call, or write the content across separate steps.",
  },
  {
    id: STEP_ANSWER_ID,
    name: "Hold the answer to its budget",
    enabled: true,
    default: true,
    hook: { type: "step-tokens", channel: "answer", tokens: 4_000 },
    text:
      "This step's reply has grown very long. Stop and end the step now: give the conclusion and the " +
      "single next action, and put the detail in a file or the next step instead of this answer.",
  },
]

const migrateBloatedTodo = (nudge: ConfigNudge.Info): ConfigNudge.Info => {
  if (
    nudge.id !== BLOATED_TODO_ID ||
    nudge.text !==
      "The $(absolute_file_path) got bloated - reduce to 30kb, remove completed items and cruft, use simple direct concise language."
  )
    return nudge
  const current = defaults().find((item) => item.id === BLOATED_TODO_ID)!
  if (
    nudge.name !== current.name ||
    nudge.hook.type !== "javascript" ||
    current.hook.type !== "javascript" ||
    nudge.hook.code !== current.hook.code ||
    nudge.script !== undefined ||
    nudge.spammable !== current.spammable
  )
    return nudge
  return { ...current, ...(nudge.enabled === undefined ? {} : { enabled: nudge.enabled }) }
}

/**
 * Normalize one STORED nudge: migrate an old built-in body, then mark shipped ids as `default` so the
 * settings UI can badge them and offer a "show default nudges" filter. A user's own edits, enabled
 * state and custom nudges are preserved untouched.
 */
export const refreshStoredDefault = (nudge: ConfigNudge.Info): ConfigNudge.Info => {
  const refreshed = migrateBloatedTodo(nudge)
  const shipped = defaults().find((item) => item.id === refreshed.id)
  return shipped !== undefined && refreshed.default !== true ? { ...refreshed, default: true } : refreshed
}

/**
 * The full nudge list an officer should have: its stored list (normalized) plus every shipped default
 * it does not already hold.
 *
 * ⚠️ An EXPLICIT empty list is honoured — that is an officer deliberately carrying no nudges, and the
 * store test pins it. Missing defaults are merged only into a NON-empty stored list, which is how the
 * cadence defaults (delegate check, project optimization, cleanup) reach agents created before those
 * defaults shipped. A fresh agent has no stored list and simply gets `defaults()`.
 */
export const withDefaults = (stored: ReadonlyArray<ConfigNudge.Info> | undefined): ReadonlyArray<ConfigNudge.Info> => {
  if (stored === undefined) return defaults()
  if (stored.length === 0) return stored
  const present = new Set(stored.map((item) => item.id))
  return [...stored.map(refreshStoredDefault), ...defaults().filter((item) => !present.has(item.id))]
}

export const validPattern = (pattern: string): boolean => {
  try {
    new RegExp(pattern, "i")
    return pattern.trim() !== ""
  } catch {
    return false
  }
}
