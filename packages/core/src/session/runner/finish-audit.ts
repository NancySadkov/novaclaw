export * as FinishAudit from "./finish-audit"

import { SessionMessage } from "../message"
import { SessionToolContent } from "../tool-content"
import { isRealUserTurn } from "../steer-provenance"
import { Introspection } from "./introspection"

export const SYSTEM =
  "You are a completion auditor. Decide whether the original user's requested work is actually " +
  "complete based only on the evidence shown. Answer with exactly YES or NO. YES means every material " +
  "part is done; NO means work remains, evidence is missing, or completion is uncertain."

export const CONTINUE_NUDGE =
  "Your exit request was reviewed and the requested work is not finished. Continue now with one concrete " +
  "next action. Use tools when needed, and do not stop at a plan or progress note."

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

export interface ExitRequest {
  readonly result: string
}

/** The newest assistant turn's successfully executed `exit` request, if it contains one. */
export const exitRequest = (context: readonly SessionMessage.Message[]): ExitRequest | undefined => {
  const assistant = context.findLast((message): message is SessionMessage.Assistant => message.type === "assistant")
  if (!assistant) return undefined
  for (let i = assistant.content.length - 1; i >= 0; i--) {
    const part = assistant.content[i]!
    if (part.type !== "tool" || part.name !== "exit" || part.state.status !== "completed") continue
    const raw = part.state.input
    let input: unknown = raw
    if (typeof raw === "string") {
      try {
        input = JSON.parse(raw)
      } catch {
        input = undefined
      }
    }
    const result =
      typeof input === "object" && input !== null && "result" in input && typeof input.result === "string"
        ? input.result
        : ""
    return { result }
  }
  return undefined
}

/**
 * The small, bounded evidence packet for the completion audit.
 *
 * Recent REAL user messages are included rather than only the first one: a durable colleague chat
 * carries many jobs, and auditing today's work against its opening "hi" confidently answers the
 * wrong question. Harness steers remain excluded by the shared provenance predicate.
 */
export const excerpt = (context: readonly SessionMessage.Message[], request: ExitRequest): string | undefined => {
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
        const output = clip(SessionToolContent.stateText(part.state)?.trim() ?? "", 220)
        activity.push(`tool ${part.name} [${state}]${output ? `: ${output}` : ""}`)
      }
      if (part.type === "text" && part.text.trim()) activity.push(`assistant: ${clip(part.text.trim(), 500)}`)
    }
  }
  if (user.length === 0 && activity.length === 0) return undefined
  return [
    ...(user.length === 0 ? [] : ["Recent user requests:", ...user]),
    ...(activity.length === 0 ? [] : ["Recent work evidence:", ...activity.slice(-8)]),
    `The agent explicitly requested exit with this result: ${clip(request.result, 500) || "(empty result)"}`,
  ].join("\n")
}

export const prompt = (evidence: string): string =>
  `Is the user's requested work actually complete? Answer only YES or NO.\n\n<work-evidence>\n${evidence}\n</work-evidence>`

export type Verdict = "yes" | "no" | "unknown"

export const verdict = (reply: string): Verdict => {
  const parsed = Introspection.verdictOf(reply)
  return parsed === "yes" || parsed === "no" ? parsed : "unknown"
}
