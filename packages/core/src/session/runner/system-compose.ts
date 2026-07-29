export * as SystemCompose from "./system-compose"

// The ordered assembly of the system-prompt parts, extracted from the runner (session/runner/llm.ts)
// so the composition — and especially the placement of the optional per-model PRE-PROMPT — is a pure
// unit, testable without executing the live runner.
//
// ⚠️ PLACEMENT of the model pre-prompt (owner 2026-07-29, todo/assorted.md "Per-model PRE-PROMPT").
// The vision wants it as a distinct, clearly-labelled section that reads as "about this model" —
// sitting AFTER the immutable base and BEFORE the persona, so a session inspecting its own prompt can
// tell base / model-preprompt / persona apart. But the ACTUAL runner composes parts persona-FIRST and
// the kernel base context LAST — the reverse of the order the vision assumes. The persona baseline is
// deliberately composed first (persona.ts: "so the assistant's approach survives model swaps"), and
// the kernel base context (`system.baseline`) trails at the end. Reordering the existing parts is
// forbidden (it must stay byte-identical when no pre-prompt is set), so the faithful realisation of
// the intent inside this order is to place the pre-prompt directly AFTER the persona baseline and
// ahead of everything else: the correction then colours all the model-/task-specific material below
// it, while remaining its own labelled block a reader can separate from the persona above it and the
// base context at the end. It rides the same `.filter(non-empty)` as every other part, so an absent
// pre-prompt changes the composed prompt not at all (byte-identical to today).

/** The header that makes the per-model pre-prompt read as "about this model" and keeps it from being
 *  mistaken for task instructions (todo/assorted.md: "Do not make it a dumping ground"). */
export const MODEL_PREPROMPT_LABEL =
  "The following are user-authored corrections for this specific model's known behaviour (not task instructions):"

/**
 * Wrap a user-authored per-model pre-prompt as a distinct, labelled section — or `undefined` when
 * there is nothing to add, so it rides the composition filter and changes the prompt not at all. A
 * whitespace-only value is treated as empty (inert).
 */
export const modelPrePromptSection = (prePrompt: string | undefined): string | undefined => {
  const trimmed = prePrompt?.trim()
  return trimmed ? `${MODEL_PREPROMPT_LABEL}\n\n${trimmed}` : undefined
}

export interface SystemPromptParts {
  /** The Nova persona baseline — composed FIRST (persona.ts), before per-session/agent prompts. */
  readonly persona?: string
  /** The optional per-model pre-prompt SECTION (already wrapped via `modelPrePromptSection`). */
  readonly modelPrePrompt?: string
  /** T9 plain-language stance line for a Normal-level user. */
  readonly expertiseHint?: string
  /** Tier scaffold for a weak model (tier-scaffold.ts). */
  readonly tierHint?: string
  /** Auto-recalled memories (recall.ts). */
  readonly memoryRecall?: string
  /** Per-session system-prompt override (the config-inheritance walk). */
  readonly systemPromptOverride?: string
  /** The selected agent's own system prompt. */
  readonly agentSystem?: string
  /** The immutable kernel base context (environment, tools, skills) — composed LAST. */
  readonly base?: string
}

/**
 * The ORDERED, non-empty system-prompt parts. The per-model pre-prompt sits immediately after the
 * persona baseline; every other part keeps its existing position, so with no pre-prompt the output is
 * byte-identical to the pre-feature array. Uses the exact same non-empty predicate the runner used
 * inline (`part !== undefined && part.length > 0`).
 */
export const composeSystemParts = (parts: SystemPromptParts): string[] =>
  [
    parts.persona,
    parts.modelPrePrompt,
    parts.expertiseHint,
    parts.tierHint,
    parts.memoryRecall,
    parts.systemPromptOverride,
    parts.agentSystem,
    parts.base,
  ].filter((part): part is string => part !== undefined && part.length > 0)
