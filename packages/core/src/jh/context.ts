export * as JhContext from "./context"

// jh — the Context Manager (jh.md §5 law 5, §6). Deterministically assembles a step's prompt context
// from the artifacts its declared-consumes closure resolved to — goal + ancestor chain + the artifact
// blocks in closure order (DIRECT consumes first, then transitive). Byte-identical for identical input
// (the caching key jh.md §6 wants): no clocks, no randomness, arrays in / string out. Over-budget
// content is elided head+tail; over-total transitive blocks drop from the END (deepest last) while
// direct consumes are never dropped, only elided harder once.

import type { JhStep } from "./step"

export interface ArtifactBlock {
  readonly id: string
  readonly type: JhStep.ArtifactType
  readonly content: string
}

export interface Limits {
  readonly perArtifactChars: number
  readonly totalChars: number
}

export const DEFAULT_LIMITS: Limits = { perArtifactChars: 8_000, totalChars: 24_000 }

/** Keep head 60% + tail 30% of the budget with an `…[elided N chars]…` marker between. */
function elideContent(content: string, budget: number): string {
  if (content.length <= budget) return content
  const head = Math.floor(budget * 0.6)
  const tail = Math.floor(budget * 0.3)
  const elided = content.length - head - tail
  return content.slice(0, head) + `…[elided ${elided} chars]…` + content.slice(content.length - tail)
}

function blockText(block: ArtifactBlock, budget: number): string {
  return `### artifact ${block.id} (${block.type})\n\`\`\`\n${elideContent(block.content, budget)}\n\`\`\``
}

function build(
  input: { taskGoal: string; ancestorGoals: ReadonlyArray<string>; stepGoal: string },
  directTexts: ReadonlyArray<string>,
  transitiveTexts: ReadonlyArray<string>,
): string {
  const parts: string[] = [`# Task\n${input.taskGoal}`]
  if (input.ancestorGoals.length > 0) parts.push(`# Plan\n${input.ancestorGoals.map((g) => `- ${g}`).join("\n")}`)
  parts.push(`# Step\n${input.stepGoal}`)
  const blocks = [...directTexts, ...transitiveTexts]
  if (blocks.length > 0) parts.push(`# Inputs\n${blocks.join("\n\n")}`)
  return parts.join("\n\n")
}

export function assemble(input: {
  readonly taskGoal: string
  readonly ancestorGoals: ReadonlyArray<string>
  readonly stepGoal: string
  readonly direct: ReadonlyArray<ArtifactBlock>
  readonly transitive: ReadonlyArray<ArtifactBlock>
  readonly limits?: Limits
}): string {
  const limits = input.limits ?? DEFAULT_LIMITS
  const directTexts = input.direct.map((b) => blockText(b, limits.perArtifactChars))
  const transitiveTexts = input.transitive.map((b) => blockText(b, limits.perArtifactChars))

  let out = build(input, directTexts, transitiveTexts)
  if (out.length <= limits.totalChars) return out

  // Over budget: drop transitive blocks from the END (deepest last), one at a time.
  const trans = [...transitiveTexts]
  while (trans.length > 0) {
    trans.pop()
    out = build(input, directTexts, trans)
    if (out.length <= limits.totalChars) return out
  }

  // All transitive dropped and still over: elide DIRECT consumes harder (half budget, once). Never drop
  // them — a dropped direct consume is exactly the failure law 5 exists to prevent.
  const harderDirect = input.direct.map((b) => blockText(b, Math.floor(limits.perArtifactChars / 2)))
  return build(input, harderDirect, [])
}
