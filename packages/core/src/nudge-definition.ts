export * as NudgeDefinition from "./nudge-definition"

import type { ConfigNudge } from "./config/nudge"

export const LOW_RESOURCE_ID = "builtin-low-resources"
export const JAVASCRIPT_TIME_ID = "builtin-javascript-time-safety"
export const NEW_DAY_ID = "builtin-new-day"

export const defaults = (): ReadonlyArray<ConfigNudge.Info> => [
  {
    id: LOW_RESOURCE_ID,
    name: "Protect work when resources run low",
    enabled: true,
    hook: { type: "resource-pressure", level: "either" },
    text:
      "This instance is low on memory or disk headroom. Avoid starting memory- or disk-intensive work. " +
      "Use tool_search for resource status, then resource_status for the live figures and confirm recovery before resuming heavy work.",
  },
  {
    id: JAVASCRIPT_TIME_ID,
    name: "Check JavaScript time conversions",
    enabled: true,
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
    id: NEW_DAY_ID,
    name: "A new day begins",
    enabled: true,
    hook: { type: "new-day" },
    text: "A new local calendar day has begun. If the exact date matters, read the clock with a tool instead of relying on prompt context.",
  },
]

export const resolved = (stored: readonly ConfigNudge.Info[] | undefined): ReadonlyArray<ConfigNudge.Info> =>
  stored === undefined ? defaults() : stored

export const validPattern = (pattern: string): boolean => {
  try {
    new RegExp(pattern, "i")
    return pattern.trim() !== ""
  } catch {
    return false
  }
}
