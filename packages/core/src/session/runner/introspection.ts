// P2 — introspection mode's pure half. The judge is an out-of-band model call at the
// runner's continuation boundary: every `cadence` steps it is shown a compact excerpt of
// the recent context and asked the introspection question; a "yes" steers the configured
// (or judge-written) interjection into the next turn. This module holds everything that
// needs no Effect services so it is unit-tested without a model: config resolution with
// canonical defaults, the cadence gate, the context excerpt, the tolerant verdict parse,
// and the judge prompts.

import type { ConfigIntrospection } from "../../config/introspection"
import { isRealUserTurn } from "../steer-provenance"
import type { SessionMessage } from "../message"
import { Model } from "@novaclaw/schema/model"

export interface Resolved {
  readonly enabled: boolean
  readonly cadence: number
  readonly model?: { providerID: string; id: string }
  readonly prompt: string
  readonly interjection: string
  readonly generateInterjection: boolean
}

export const DEFAULT_CADENCE = 3

export const DEFAULT_PROMPT =
  "You are auditing another AI agent's work-in-progress. Judge ONLY whether the agent is stuck: " +
  "looping over the same actions, repeating failed attempts without changing approach, or making no " +
  "progress toward the task. Answer with a single word — YES if it is stuck or looping and needs an " +
  "interjection to force a change of course now, NO otherwise."

export const DEFAULT_INTERJECTION =
  "You appear to be stuck or looping. Stop repeating the same approach — take ONE concrete, different " +
  "action now, or ask the user a specific question."

/** Cap the judge's context excerpt — the judge needs a glimpse, not the transcript. */
export const MAX_EXCERPT_CHARS = 4_000

/** Parse "provider/model" (the model id itself may contain slashes). */
export const parseModelRef = Model.parseRef

export function resolve(config: ConfigIntrospection.Info | undefined): Resolved {
  const cadence = config?.cadence !== undefined && config.cadence >= 1 ? Math.floor(config.cadence) : DEFAULT_CADENCE
  return {
    enabled: config?.enabled ?? false,
    cadence,
    model: parseModelRef(config?.model),
    prompt: config?.prompt?.trim() || DEFAULT_PROMPT,
    interjection: config?.interjection?.trim() || DEFAULT_INTERJECTION,
    generateInterjection: config?.generateInterjection ?? false,
  }
}

/** Judge on every cadence-th CONTINUATION step (step 1 is the first provider turn — never judged). */
export function shouldJudge(step: number, cadence: number): boolean {
  return step > 1 && (step - 1) % cadence === 0
}

/**
 * A compact excerpt of the recent context for the judge: the last assistant text plus the
 * last few tool calls with their results (name + input + truncated output) — the signals a
 * stuck-detector actually needs. Returns undefined when there is nothing to judge.
 */
export function judgeExcerpt(context: ReadonlyArray<SessionMessage.Message>): string | undefined {
  const lines: string[] = []
  /**
   * 🔴 **The judge is asked whether the agent is "making no progress toward the task", and until
   * 2026-08-26 it was never shown the task.** It saw recent tool calls and the last assistant text and
   * had to infer the goal from them — which is the one thing a stuck agent's output is least able to
   * convey, because a looping agent's recent turns all look purposeful in isolation.
   *
   * ⚠️ `isRealUserTurn`, never `type === "user"` — a harness-injected steer rides the user role, and
   * `session/steer-provenance.ts` owns that distinction (a guard test fails any unfiltered read).
   * The FIRST turn, not the last: a steer or a follow-up is not the objective, and the
   * drive injects user-role messages of its own. Clipped hard — the judge needs the goal, not the
   * briefing (NC-PROMPT-LANG-003).
   */
  const task = context.filter(isRealUserTurn).map((message) => message.text ?? "").find((text) => text.trim())
  if (task) lines.push("The task the agent was given:", clip(task.trim(), 400))
  const assistants = context.filter((message) => message.type === "assistant")
  const tools: string[] = []
  for (const message of assistants) {
    for (const part of message.content) {
      if (part.type !== "tool") continue
      const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
      const output =
        part.state.status === "completed" || part.state.status === "error"
          ? "output" in part.state && typeof part.state.output === "string"
            ? part.state.output
            : ""
          : `(${part.state.status})`
      tools.push(`tool ${part.name}(${clip(input, 200)}) -> ${clip(output, 300) || "(no output)"}`)
    }
  }
  if (tools.length) lines.push("Recent tool calls:", ...tools.slice(-6))
  const lastText = [...assistants]
    .reverse()
    .flatMap((message) => message.content.filter((part) => part.type === "text"))
    .find((part) => part.text.trim())
  if (lastText) lines.push("Last assistant text:", clip(lastText.text.trim(), 1_000))
  if (!lines.length) return undefined
  const excerpt = lines.join("\n")
  return excerpt.length > MAX_EXCERPT_CHARS ? excerpt.slice(-MAX_EXCERPT_CHARS) : excerpt
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text
}

/**
 * The four things a closed yes/no question can actually come back as.
 *
 * 🔴 **`empty` and `unparsed` are NOT `no`, and folding them there is a rate summing two failure
 * modes.** An `empty` reply is a BUDGET fault — a thinking model given too small an allowance returns
 * no content and no reasoning (measured: 18/24 at 300 tokens against 24/24 at 2048) — and an
 * `unparsed` one is a COMPREHENSION fault. Both are facts about the instrument; `no` is a fact about
 * the subject. A caller that cannot tell them apart reports the instrument's failure as the subject's
 * answer, and an empty rate that is not zero stays invisible exactly when it matters.
 *
 * This is why the parse is exposed as four outcomes and the boolean is a WRAPPER over it: the
 * collapse is a per-caller POLICY, not a property of parsing.
 */
export type Verdict = "yes" | "no" | "empty" | "unparsed"

/**
 * Tolerant verdict parse — small models decorate ("Yes.", "**YES** — the agent…",
 * reasoning followed by a verdict line). Look for a yes/no token near the START of the
 * reply, then fall back to the final line.
 *
 * ⚠️ Whitespace-only counts as `empty`, not `unparsed` — a model that returned nothing and a model
 * that returned prose we could not read are different diagnoses with different fixes (raise the
 * budget vs. reword the question).
 */
export function verdictOf(reply: string): Verdict {
  const trimmed = reply.trim()
  if (!trimmed) return "empty"
  const head = trimmed.slice(0, 40).toLowerCase()
  if (/^\W*no\b/.test(head)) return "no"
  if (/^\W*yes\b/.test(head)) return "yes"
  const lines = trimmed.split(/\r?\n/)
  const last = (lines[lines.length - 1] ?? "").trim().toLowerCase()
  if (/^\W*no\b/.test(last)) return "no"
  if (/^\W*yes\b/.test(last)) return "yes"
  return "unparsed"
}

/**
 * Introspection's own POLICY over `verdictOf`: anything that is not a clear yes is treated as no,
 * because interjecting on an unclear verdict interrupts a healthy agent. Behaviour is unchanged from
 * when this was the only parse — the difference is that the collapse is now stated here, at the
 * caller that wants it, instead of being welded into the parser every other caller shares.
 */
export function isYesVerdict(reply: string): boolean {
  return verdictOf(reply) === "yes"
}

/** The user message the judge receives (question + excerpt). */
export function judgePrompt(prompt: string, excerpt: string): string {
  return `${prompt}\n\n<recent-agent-context>\n${excerpt}\n</recent-agent-context>`
}

/** The follow-up prompt when the judge itself writes the interjection. */
export function generatePrompt(excerpt: string): string {
  return (
    "The agent above IS stuck. Write a short interjection (1-3 sentences, imperative, second person) " +
    "that will be injected into its conversation to force a concrete change of course. Refer to what " +
    "it was doing. Output ONLY the interjection text.\n\n" +
    `<recent-agent-context>\n${excerpt}\n</recent-agent-context>`
  )
}

export * as Introspection from "./introspection"
