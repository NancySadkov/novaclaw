// 1E harness-robustness: detect a doom loop — the model calling the same tool with
// the same arguments over and over, making no progress — and produce a redirect to
// break it. Mirrors the legacy V1 detector (3 identical consecutive calls) and afpro's
// repeat-action intervention. Pure and unit-testable; the runner extracts recent tool
// calls from projected history and feeds them here, then injects `redirectMessage` via
// the shared in-loop inject helper (F2) so the next turn sees it.

import type { SessionMessage } from "../message"
import { lastRealUserIndex } from "../steer-provenance"

export const DOOM_LOOP_THRESHOLD = 3

export interface ToolCallRef {
  readonly name: string
  readonly input: string
}

const key = (call: ToolCallRef) => `${call.name}\x00${call.input}`

// Returns the offending call if the last `threshold` tool calls are byte-identical
// (same name AND same arguments), otherwise undefined.
export function detectDoomLoop(
  calls: ReadonlyArray<ToolCallRef>,
  threshold: number = DOOM_LOOP_THRESHOLD,
): ToolCallRef | undefined {
  if (threshold < 2 || calls.length < threshold) return undefined
  const recent = calls.slice(-threshold)
  const first = key(recent[0]!)
  return recent.every((call) => key(call) === first) ? recent[0] : undefined
}

export function redirectMessage(call: ToolCallRef, threshold: number = DOOM_LOOP_THRESHOLD): string {
  return (
    `You have called \`${call.name}\` with identical arguments ${threshold} times in a row with no change in ` +
    `result — this is a loop. Stop repeating it. Re-read the most recent output or error carefully, then either ` +
    `try a genuinely different approach (a different tool, command, or arguments) or ask the user a specific ` +
    `question. Do not call \`${call.name}\` with the same arguments again.`
  )
}

// 1N / codehamr A2 — the exact-repeat detector above is defeated by ANY cosmetic rewording between
// retries (a regenerated file body, a reworded command), and small models *always* reword. The two
// detectors below catch what it can't: a failure STREAK keyed on tool+target (not full args), and a
// runaway iteration count. Both are pure and unit-tested; the runner feeds them the tool calls made
// since the last user message ("a new user message is a new goal") and steers the message on a trip.

// Generous on purpose — honest trial-and-error is allowed. 3 consecutive same-target failures is a
// loop, not exploration.
//
// Lowered 5 -> 3 (ported from NancySadkov/novaclaw#6 by @DassaultFalconKing). Their packaged local-model
// E2E measured a weak model burning THIRTEEN calls before the old threshold tripped, because each retry
// reformatted the same bad patch and only every other one landed on the same key. Three is still two
// more attempts than a model needs to notice an error it can read.
export const FAILURE_STREAK_THRESHOLD = 3

// Honest large builds ran ~60 tool calls in a turn; 75 catches plausible non-failing loops
// (re-read/re-grep forever) the failure streak can't see, without tripping real work.
export const RUNAWAY_THRESHOLD = 75

export interface FailedCallRef extends ToolCallRef {
  // A tool call is a FAILURE for streak purposes when its result errored. Parse-error sentinels and
  // unknown-tool results MUST be classified as failures by the caller "or the nudge never fires on
  // exactly the loops it was built for" (codehamr).
  readonly failed: boolean
}

export interface FailureStreak {
  readonly name: string
  readonly target: string
  readonly count: number
}

const TARGET_FIELDS = ["command", "pattern", "path", "filePath", "filename", "query"] as const

/**
 * The file an `apply_patch` body acts on, so a malformed patch retried with cosmetic differences
 * keeps ONE streak key.
 *
 * ⚠️ Without this, `apply_patch` has no field in `TARGET_FIELDS` — its input is `patchText` — so
 * `toolTargetKey` fell through to the trimmed raw arguments. A weak model regenerates the whole body
 * on each retry (different whitespace, reordered context lines), so every attempt produced a NEW key
 * and the streak reset forever. Measured by @DassaultFalconKing in NancySadkov/novaclaw#6: thirteen
 * failed calls before any nudge fired. This is the general lesson of the failure-streak detector,
 * restated for the one tool whose payload IS the argument: key on what the call acts on, never on how
 * it is spelled.
 *
 * Reads the official envelope first (`*** Add|Update|Delete File: <path>`), then a unified-diff
 * `+++ <path>` as a fallback for a model that reached for the format it knows. Pure and total.
 */
export function patchTarget(value: string): string | undefined {
  const lines = value.split("\n").map((line) => line.trim())
  const official = lines
    .map((line) => /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/.exec(line)?.[1]?.trim())
    .find((target) => target)
  if (official) return official
  return lines
    .map((line) => /^\+\+\+\s+(?!\/dev\/null$)(?:[ab]\/)?(.+)$/.exec(line)?.[1]?.trim())
    .find((target) => target)
}

// Extract the *target* a tool acts on, so cosmetic argument rewording between retries does not reset
// the streak. bash/shell → the first line of `command`; glob/grep → `pattern`; file tools → `path`.
// Falls back to the trimmed raw args when nothing parses. Pure and total.
export function toolTargetKey(name: string, input: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return `${name}\x00${input.trim()}`
  }
  if (parsed !== null && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>
    // Checked BEFORE TARGET_FIELDS: a patch body may also carry a `path`, and the envelope is the
    // more specific answer to "what does this call act on".
    if (typeof record["patchText"] === "string") {
      const target = patchTarget(record["patchText"])
      if (target) return `${name}\x00${target}`
    }
    for (const field of TARGET_FIELDS) {
      const value = record[field]
      if (typeof value === "string" && value.length > 0) {
        const target = field === "command" ? (value.split("\n")[0] ?? value).trim() : value.trim()
        return `${name}\x00${target}`
      }
    }
  }
  return `${name}\x00${input.trim()}`
}

// Walk backward from the newest call, counting consecutive FAILURES that share the same tool+target.
// A success or a different target ends the streak. Returns the streak once it reaches `threshold`.
// Callers pass only the calls since the last user message so the streak resets per new goal.
export function detectFailureStreak(
  calls: ReadonlyArray<FailedCallRef>,
  threshold: number = FAILURE_STREAK_THRESHOLD,
): FailureStreak | undefined {
  if (threshold < 2 || calls.length < threshold) return undefined
  const newest = calls[calls.length - 1]!
  if (!newest.failed) return undefined
  const target = toolTargetKey(newest.name, newest.input)
  let count = 0
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i]!
    if (!call.failed || toolTargetKey(call.name, call.input) !== target) break
    count++
  }
  if (count < threshold) return undefined
  return { name: newest.name, target: target.split("\x00").slice(1).join("\x00"), count }
}

export function failureStreakMessage(streak: FailureStreak): string {
  return (
    `The last ${streak.count} tool calls to the same target (\`${streak.name}\`${
      streak.target ? ` → ${streak.target}` : ""
    }) failed the same way. Stop repeating it — read the error, change your approach, or tell the user ` +
    `what's blocking you.`
  )
}

// The runaway nudge is deliberately SELF-ASSESSMENT, never "stop" — telling a small model to stop
// mid-task is the premature-completion failure we otherwise fight. `>=` (a multi-call round can jump
// the counter). Latched once per turn by the caller.
export function detectRunaway(toolCallCount: number, threshold: number = RUNAWAY_THRESHOLD): boolean {
  return toolCallCount >= threshold
}

export function runawayMessage(toolCallCount: number): string {
  return (
    `${toolCallCount} tool calls so far this turn without finishing. If you're still making real progress, ` +
    `keep going. If you're repeating a step that can't work here, stop chasing it (that loop burns the turn); ` +
    `verify another way. If you're stuck or unsure you're converging, tell the user where things stand.`
  )
}

// 1N / codehamr A3 — a turn ending with NO text AND no tool call is a silent dead stop, typically a
// thinking model whose tool call streamed into the reasoning channel and was dropped by the server's
// parser. Inject ONE synthetic re-prompt (latched per turn, re-armed by the runner whenever genuine
// progress lands). We already recover text-dumped calls at decode (`tool-recovery.ts`); this covers
// the case where the SERVER itself ate the call.
export const EMPTY_TURN_RECOVERY =
  "Your last turn ended with no reply and no tool call. If you meant to call a tool and it did not " +
  "run, issue it again now as a proper tool call. Otherwise finish with a short, verified summary."

// After two CONSECUTIVE empty turns the re-prompt isn't working — surface a user-facing diagnostic
// naming the server-side fix, because the fault is almost certainly the model server's config.
export const EMPTY_TURN_DIAGNOSTIC =
  "The model produced two turns in a row with no reply and no tool call. This usually means the model " +
  "server is dropping tool calls emitted on the reasoning channel — enable a reasoning parser (e.g. " +
  "vLLM `--reasoning-parser`) or disable thinking for tool turns."

// 2E (codehamr A7) — the deterministic finish re-grounding backstop. When a SUBSTANTIAL turn
// (≥ this many tool calls since the last real user message) is about to end with a clean,
// confident summary, one re-prompt walks the model through its own acceptance criteria. Zero
// LLM cost — this is the always-on tier under the P2 judge.
export const REGROUND_TOOL_CALLS = 8

export const REGROUND_NUDGE =
  "Before you finish: walk the original request's acceptance criteria one at a time; for each, " +
  "name the check you actually ran and what it showed. If you haven't run it, run it now — or " +
  "probe its absence with one read-only command. Never dress up a static check (a brace count, " +
  "a grep, an HTTP 200) as proof. If a check genuinely can't be run here, report it as " +
  "`unverified: <what> — <why>` and lead your summary with that gap."

// The honesty exemption — the battle scar to respect: re-prompting an honest
// "unverified: browser runtime" has been seen to REGRESS into a confident, caveat-free
// "it works". A finish that already admits its gaps stands.
export const containsUnverified = (text: string): boolean => /unverified/i.test(text)

/** The newest assistant message's visible text (reasoning excluded), for the honesty check. */
export const lastAssistantText = (context: readonly SessionMessage.Message[]): string => {
  for (let i = context.length - 1; i >= 0; i--) {
    const message = context[i]!
    if (message.type !== "assistant") continue
    return message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim()
  }
  return ""
}

/**
 * Fire the re-grounding nudge? Only for a substantial turn (toolCallCount ≥ threshold) that is
 * ending with real summary text which does NOT already admit an `unverified:` gap.
 */
export const shouldReground = (
  finalText: string,
  toolCallCount: number,
  threshold: number = REGROUND_TOOL_CALLS,
): boolean => toolCallCount >= threshold && finalText !== "" && !containsUnverified(finalText)

// 1N/A2 — tool calls made since the last REAL user message, each classified failed/ok from its
// projected state. Scoping to "since the last user message" gives the failure streak + runaway
// detectors their per-goal reset ("a new user message is a new goal") for free. Crucially, harness
// steers ALSO project as user-type messages (`session.next.prompted` → `SessionMessage.User`) — they
// must NOT reset the window, or the doom-loop's own nudge / an introspection interjection would wipe
// the very streak it was fired for. Steers are recognizable by the A1 provenance prefix — asked here
// through the ONE shared predicate (`session/steer-provenance.ts`), not a local re-declaration of it,
// which is what this module used to carry (B2).
export const toolCallsSinceLastUser = (context: readonly SessionMessage.Message[]): FailedCallRef[] => {
  const lastUserIndex = lastRealUserIndex(context)
  const refs: FailedCallRef[] = []
  for (let i = lastUserIndex + 1; i < context.length; i++) {
    const message = context[i]!
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool") continue
      refs.push({
        name: part.name,
        input: typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input),
        failed: part.state.status === "error",
      })
    }
  }
  return refs
}

// 1N/A3 — a turn is "empty" when its assistant message has no non-empty text AND no tool call
// (reasoning does not count — a leaked-into-reasoning tool call the server dropped is exactly this
// case). A turn that recorded an `error` is NOT empty: that is 1D's retry territory, not a stall.
export const isEmptyAssistantTurn = (context: readonly SessionMessage.Message[]): boolean => {
  let lastAssistant: SessionMessage.Assistant | undefined
  for (let i = context.length - 1; i >= 0; i--) {
    const message = context[i]!
    if (message.type === "assistant") {
      lastAssistant = message
      break
    }
  }
  if (!lastAssistant || lastAssistant.error !== undefined) return false
  const hasText = lastAssistant.content.some((part) => part.type === "text" && part.text.trim() !== "")
  const hasTool = lastAssistant.content.some((part) => part.type === "tool")
  return !hasText && !hasTool
}
