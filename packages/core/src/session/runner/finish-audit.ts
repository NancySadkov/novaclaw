export * as FinishAudit from "./finish-audit"

import { SessionMessage } from "../message"
import { isRealUserTurn } from "../steer-provenance"
import { Introspection } from "./introspection"

export const SYSTEM =
  "You are a completion auditor. Decide whether the original user's requested work is actually " +
  "complete based only on the evidence shown. Answer with exactly YES or NO. YES means every material " +
  "part is done; NO means work remains, evidence is missing, or completion is uncertain."

export const CONTINUE_NUDGE =
  "A completion check found that the requested work is not finished. Continue now with one concrete " +
  "next action. Use tools when needed, and do not stop at a plan or progress note."

export const REPLY_NUDGE =
  "A completion check found that the requested work is finished, but your last turn gave the user no " +
  "reply. Write the final user-facing response now: state the outcome, the verification you actually " +
  "observed, and any remaining unverified gap. Do not call another tool."

export const UNKNOWN_NUDGE =
  "Your last turn ended with no user-visible reply. Re-check whether the requested work is complete. " +
  "If anything remains, continue with one concrete action now. If it is complete, write the final " +
  "user-facing response now."

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

/**
 * The small, bounded evidence packet for the completion audit.
 *
 * Recent REAL user messages are included rather than only the first one: a durable colleague chat
 * carries many jobs, and auditing today's work against its opening "hi" confidently answers the
 * wrong question. Harness steers remain excluded by the shared provenance predicate.
 */
export const excerpt = (context: readonly SessionMessage.Message[]): string | undefined => {
  const user = context
    .filter(isRealUserTurn)
    .slice(-3)
    .map((message) => clip((message.text ?? "").trim(), 500))
    .filter(Boolean)
  const activity: string[] = []
  for (const message of context) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type === "tool") {
        const state = part.state.status
        const output =
          (state === "completed" || state === "error") && "output" in part.state && typeof part.state.output === "string"
            ? clip(part.state.output.trim(), 220)
            : ""
        activity.push(`tool ${part.name} [${state}]${output ? `: ${output}` : ""}`)
      }
      if (part.type === "text" && part.text.trim()) activity.push(`assistant: ${clip(part.text.trim(), 500)}`)
    }
  }
  if (user.length === 0 && activity.length === 0) return undefined
  return [
    ...(user.length === 0 ? [] : ["Recent user requests:", ...user]),
    ...(activity.length === 0 ? [] : ["Recent work evidence:", ...activity.slice(-8)]),
    "The latest agent turn then ended with no text and no tool call.",
  ].join("\n")
}

export const prompt = (evidence: string): string =>
  `Is the user's requested work actually complete? Answer only YES or NO.\n\n<work-evidence>\n${evidence}\n</work-evidence>`

export type Verdict = "yes" | "no" | "unknown"

export const verdict = (reply: string): Verdict => {
  const parsed = Introspection.verdictOf(reply)
  return parsed === "yes" || parsed === "no" ? parsed : "unknown"
}

export const nudge = (answer: Verdict): string =>
  answer === "yes" ? REPLY_NUDGE : answer === "no" ? CONTINUE_NUDGE : UNKNOWN_NUDGE
