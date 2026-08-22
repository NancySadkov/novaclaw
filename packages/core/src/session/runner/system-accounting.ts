export * as SystemAccounting from "./system-accounting"

import { Token } from "../../util/token"
import type { SystemCompose } from "./system-compose"

// PER-BLOCK PROMPT ACCOUNTING (`todo/tool-scale.md`, adopted from
// `notes/survey/agent-office-research.md` §1.2).
//
// 🔴 **The instrument this program has been arguing without.** Every prompt-size number on record is
// a tool-wire capture, so "tools are 31.9% of the body" has no denominator anyone can break down —
// and a prompt that grows names nothing. The blocks already exist and are already named
// (`SystemCompose.composeSystemParts` orders them); what was missing was counting them.
//
// ⚠️ **ONE instrument, deliberately.** `todo/named-agents.md` needs this to prove a chit-chat role
// packs less than an engineering one, and the standing instruction is "one instrument, not two". It
// uses `Token.estimate` — the same chars/4 estimator `context-pack` bills the window with — so a
// block's cost here and its cost there cannot disagree.
//
// ⚠️ It reports; it does not squeeze. The survey's system applies a PROPORTIONAL trim to every block
// when over budget, including the one holding its safety rules — and a safety block that can be
// trimmed is not a safety block. Capping is a separate decision that needs this measurement first,
// which is the order the todo asks for.

/** The blocks, in the order `composeSystemParts` emits them. */
export const BLOCKS = [
  "persona",
  "modelPrePrompt",
  "expertiseHint",
  "tierHint",
  "systemPromptOverride",
  "agentSystem",
  "toolDiscovery",
  "perception",
  "memoryStance",
  "projectScope",
  "base",
] as const

export type Block = (typeof BLOCKS)[number]

export interface BlockCount {
  readonly block: Block
  readonly chars: number
  readonly tokens: number
}

export interface Accounting {
  /** Only the blocks that are PRESENT, in emission order. */
  readonly blocks: readonly BlockCount[]
  readonly chars: number
  readonly tokens: number
  /** The largest block, or `undefined` when the prompt is empty — what a regression should name. */
  readonly largest: BlockCount | undefined
}

/**
 * Count what each named block costs.
 *
 * ⚠️ Absent blocks are OMITTED rather than reported as zero. A zero row reads as "this block is here
 * and empty", which is a different fact from "this session has no project scope" — and a table full
 * of zeroes is how a reader stops reading the table. Same rule the peak-memory series follows:
 * missing is not zero.
 */
export const of = (parts: SystemCompose.SystemPromptParts): Accounting => {
  const blocks: BlockCount[] = []
  for (const block of BLOCKS) {
    const text = (parts as Record<string, string | undefined>)[block]
    if (text === undefined || text.length === 0) continue
    blocks.push({ block, chars: text.length, tokens: Token.estimate(text) })
  }
  const chars = blocks.reduce((total, entry) => total + entry.chars, 0)
  return {
    blocks,
    chars,
    tokens: blocks.reduce((total, entry) => total + entry.tokens, 0),
    largest: blocks.reduce<BlockCount | undefined>(
      (biggest, entry) => (biggest === undefined || entry.tokens > biggest.tokens ? entry : biggest),
      undefined,
    ),
  }
}

/**
 * The report, as one line per block plus a total.
 *
 * ⚠️ Percentages are of the SYSTEM PROMPT, not of the request — the denominator this instrument can
 * honestly supply. Claiming a share of "the body" would need the messages too, which is
 * `context-pack`'s measurement and not this one's.
 */
export const report = (accounting: Accounting): string => {
  if (accounting.blocks.length === 0) return "system prompt: empty"
  const share = (tokens: number) => (accounting.tokens === 0 ? 0 : Math.round((tokens / accounting.tokens) * 100))
  const lines = accounting.blocks.map(
    (entry) => `  ${entry.block.padEnd(20)} ${String(entry.tokens).padStart(6)} tok  ${String(share(entry.tokens)).padStart(3)}%`,
  )
  return [`system prompt: ${accounting.tokens} tok across ${accounting.blocks.length} blocks`, ...lines].join("\n")
}
