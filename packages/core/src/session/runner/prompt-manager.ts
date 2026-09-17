export * as PromptManager from "./prompt-manager"

/**
 * THE ONE SYSTEM PROMPT, and its single source of authority.
 *
 * 🔴 **Owner, 2026-09-17.** The prompt was assembled from a dozen slots spread over
 * `system-compose.ts`, the runner's inline part builder and `context-template.ts`. The owner asked
 * for ONE monolithic `role: "system"` message, generated at a session's start and again after each
 * compaction, and for the older formation mechanisms to be retired rather than kept beside it.
 *
 * ⚠️ **Pure on purpose.** Everything this module needs arrives in {@link Input}; the environment,
 * the roster, the memo area, the project listing and the compaction work-log are all gathered by the
 * runner and handed over. That keeps the one function that decides what every model reads testable
 * without a database, an Effect graph or a live session.
 *
 * ⚠️ **Regeneration cadence is NOT enforced here.** This module is a pure renderer: call it exactly
 * at a new session and after a compaction, and reuse the result between those points. The runner
 * gets that for free because the prompt is one epoch source with an always-equivalent comparator —
 * see `SessionContextEpoch` — so a casual turn cannot churn it.
 */

/** One memo item, as the prompt renders it. Mirrors `Durable.Item` structurally. */
export interface Memo {
  readonly name: string
  readonly value: string
}

/** Which of the three colleague kinds this prompt is for. */
export type Kind = "agent" | "chat" | "human"

export interface Input {
  readonly kind: Kind
  /** The officer's name. */
  readonly name?: string | undefined
  /** The officer's job title. */
  readonly title?: string | undefined
  /** Display name of the officer's superior; absent means the owner (Nova and the owner itself). */
  readonly superior?: string | undefined
  /** The officer's direct reports, by display name. Empty = none. */
  readonly subordinates: readonly string[]
  /** The officer's durable job instructions (`officer_settings_profile` → its `system` field). */
  readonly jobInstructions?: string | undefined
  /** `uname -o`-equivalent: the OS name. */
  readonly os: string
  /** `uname --kernel-release`-equivalent. */
  readonly kernelRelease: string
  /** `uname -m`-equivalent. */
  readonly arch: string
  /** Absolute path to the shell the agent runs commands in. */
  readonly shell: string
  /** The instance owner's username. */
  readonly owner: string
  /** Absolute path to the agent's private scratch folder. */
  readonly scratch?: string | undefined
  /** The officer's durable goal. Rendered only while the session is unattended. */
  readonly goal?: string | undefined
  /** Whether the session is in unattended mode. */
  readonly unattended: boolean
  /** The session's memo items, in the order the area renders them. */
  readonly memos: readonly Memo[]
  /** Absolute path to the agent's project folder. */
  readonly project?: string | undefined
  /** Names (no path) of the entries in the project folder. */
  readonly projectFiles?: readonly string[] | undefined
  /** Absolute path to the newest JSON work-log, when a compaction has happened. */
  readonly workLog?: string | undefined
}

/** The byte budget for the inline project listing, after which the model is told to `ls`. */
export const PROJECT_LIST_BUDGET = 2048

/**
 * The project listing, bounded by BYTES rather than by count.
 *
 * ⚠️ The bound is on the RENDERED bytes, not the number of names: one 4 KB filename costs what it
 * costs. The caller's order is preserved and the truncation notice is always emitted when anything
 * was dropped — a list that silently ends is the omission this repo's own rules forbid.
 */
export const renderProjectFiles = (files: readonly string[]): string => {
  const shown: string[] = []
  let bytes = 0
  let truncated = false
  for (const name of files) {
    const cost = Buffer.byteLength(name, "utf8") + 2
    if (bytes + cost > PROJECT_LIST_BUDGET) {
      truncated = true
      break
    }
    shown.push(name)
    bytes += cost
  }
  const body = shown.join(", ")
  if (!truncated) return body
  return `${body}\n<use ls to list the rest>`
}

/** The memo block, or `undefined` when there is nothing to render. */
export const renderMemos = (memos: readonly Memo[]): string | undefined => {
  if (memos.length === 0) return undefined
  return ["# memo_set memos", ...memos.map((memo) => `${memo.name}: ${memo.value}`)].join("\n")
}

/** `Your subordinates are A, B, C.` — or `You have no subordinates.` */
const renderSubordinates = (subordinates: readonly string[]): string =>
  subordinates.length === 0 ? "You have no subordinates." : `Your subordinates are ${subordinates.join(", ")}.`

/**
 * The preamble every agent-kind officer receives. Operator-authored, byte-stable, and deliberately
 * a paragraph rather than a bullet list (the same instruction it carries).
 */
export const AGENT_PREAMBLE = [
  "You're officer agent of a NovaClaw instance — multi-agent AI harness with hierarchical organization. Each agent has a job and a superior agent. Instance CEO Nova is subordinate to instance owner, who has absolute authority over all agents. Work pragmatically and capably. Be honest, direct, concise, and high-signal. Push back on irrational proposals with a better option and concrete pitfalls; if superior or owner confirms, proceed. Make routine judgment calls yourself. Ask only when plausible interpretations would materially change the result, and meanwhile finish everything that does not depend on the answer. Use brief paragraphs. Avoid bullet or numbered lists unless the user asks for them or a complex sequence is clearer as a list. Before acting, inspect the relevant context and break complex work into manageable steps. Prefer small, surgical changes over broad rewrites. Verify each change where possible. Report only what you observed: lead with failures, skipped checks, or incomplete work, and name anything unverified. If project has AGENTS.md - check it first.",
  `Your tool list is PARTIAL. To reach other tools, call tool_search with a plain-language description of the capability you need (for example "read a sqlite database", "take a screenshot", "send a message"). It returns their complete schemas; then call the tool you want by its exact name. When asked what you can do, or when no listed tool fits the task, search before you answer or decline. Answering from the listed tools alone will be wrong.`,
  "Use `memo_set NAME VALUE` and `memo_clear NAME` to set important durable memos surviving compactions.",
  "Delegate SIZEABLE, INDEPENDENT work in parallel to sub-agents: spawn creates a nameless helper in a fresh context; it performs task and ends. Do yourself bounded tasks you can finish in a few tool calls.\nFor a real split, call spawn once per part in the same turn, continue other independent work, then collect the results. Do not redo a child's part while it runs, and verify its evidence or changed state before reporting it complete. When explicitly asked to delegate, do not do the parts yourself. Do not look for spawn — it is already in your tool list.",
  "Use colleague tool too delegate work to a subordinate or to message your superior about blocked task or conflicts other officer like edit wars.",
  [
    "Use ImageMagick for basic graphics work.",
    "magick in.png out.webp",
    "magick identify in.png",
    "magick in.png -crop 100x80+10+10 out.png",
    'magick -size 64x48 xc:navy -stroke yellow -fill none -draw "rectangle 5,5 30,30" out.png',
    "point, line, rectangle, circle, ellipse, polygon, text:",
    "  magick in.png -fill red -draw \"point 2,3\" out.png # set pixel",
    '  magick in.png -format "%[pixel:p{2,3}]" info: # get pixel',
  ].join("\n"),
].join("\n\n")

/**
 * THE PROMPT.
 *
 * A pure chat is its job instructions and nothing else — no wrapper, no environment, no tools. When
 * those instructions are empty there is no system prompt at all, which is the owner's explicit rule
 * ("If job instructions are empty, then there is just no system prompt. No tools, no nothing.").
 * A human is never run by the model, so it produces nothing.
 */
export const generate = (input: Input): string => {
  if (input.kind === "chat") return input.jobInstructions?.trim() ?? ""
  if (input.kind === "human") return ""

  const job = input.jobInstructions?.trim()
  const blocks: string[] = [AGENT_PREAMBLE]
  blocks.push(
    [
      `This instance runs on ${input.os} ${input.kernelRelease} / ${input.arch}.`,
      `Shell: ${input.shell}`,
      "",
      `Instance owner is ${input.owner}.`,
      `Your name is ${input.name ?? input.owner}.${input.title === undefined ? "" : ` Your job title is ${input.title}.`}`,
      `Your superior is ${input.superior ?? input.owner}`,
      renderSubordinates(input.subordinates),
      `Job Instructions: ${job ?? ""}`,
    ].join("\n"),
  )
  if (input.scratch !== undefined && input.scratch.trim().length > 0)
    blocks.push(
      `${input.scratch} is your private workspace — use for intermediate files, instead of littering project's folder.`,
    )
  if (input.unattended && (input.goal?.trim() ?? "").length > 0)
    blocks.push(`Your durable goal, set for you by whoever assigned this work:\n\n${input.goal!.trim()}`)
  const memos = renderMemos(input.memos)
  if (memos !== undefined) blocks.push(memos)
  if (input.project !== undefined && input.project.trim().length > 0) {
    const listing = (input.projectFiles ?? []).length === 0 ? "" : renderProjectFiles(input.projectFiles!)
    blocks.push(
      listing.length === 0
        ? `Your project is ${input.project}`
        : `Your project is ${input.project}\nIt has following files:\n${listing}`,
    )
  }
  if (input.workLog !== undefined && input.workLog.trim().length > 0)
    blocks.push(`Earlier work-log: ${input.workLog}.`)
  return blocks.filter((block) => block.length > 0).join("\n\n")
}
