export * as SystemCompose from "./system-compose"

import type { PermissionMode } from "../config-resolve"

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

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT SCOPE — the guidance half of the owner's 2026-07-30 directive.
//
// Verbatim: *"the model should be instructed by a non-YOLO mode system that it should not modify
// any files outside of the project's folder."* It is the counterweight to the same directive's
// other half: unattended `bash` now runs on hosts with no sandbox backend (`agent-jail.ts`), and
// `bash`'s permission resource is the command STRING, which `permission.ts` says in its own words
// is not containment. So for the shell — and only for the shell — this instruction is the boundary
// until v0.3.0 ships a real one.
//
// ⚠️ Be honest about what that means, because AGENTS.md pitfall #1 states the law it is up against:
// *informational levers engage, mechanical ones convert.* This is an informational lever and it
// does not contain a hostile command. It is not, however, the only thing standing: every tool whose
// resource is a PATH — read/edit/write/create/trash/apply-patch, and `bash`'s own `workdir` — still
// goes through `LocationMutation.externalDirectoryPermission`, which asks in an attended chain and
// hard-denies in an unattended one. The gap this text covers is the command string, which no rule
// can see. Deleting the text would not make the product safer by being more honest; it would remove
// the one thing that reaches the party actually choosing the command.
//
// ⚠️ ABSENT IN `yolo`, and that is the whole reason the mode exists. `MODE_RULES.yolo` is the one
// overlay that ALLOWS `external_directory_write` outright — documented as "everything, incl.
// outside the project". A system prompt telling a yolo session to stay in its folder would
// contradict the posture the user deliberately picked, and a prompt that argues with the product's
// own settings teaches the model to discount both.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The project-scope rule, as the model reads it. Written to the 1P house style — say what is
 * allowed before what is not, name the escape hatch, and never imply the user is the threat.
 *
 * Three drafting choices that are load-bearing rather than stylistic:
 *  · READS are explicitly allowed. The default posture already permits them (`permission.ts`'s read
 *    baseline: *"reading outside the project folder is ordinary work — a toolchain, an SDK, a system
 *    header"*), and a prompt that forbade them would break real tasks while contradicting the
 *    evaluator — the model would then have to guess which of the two to believe.
 *  · It names WRITES by their verbs (create/modify/move/delete) rather than saying "don't touch
 *    anything", because the vague version is the one a model rationalises its way around.
 *  · It says what to do INSTEAD (ask, and let the user decide) rather than only refusing. An
 *    instruction with no route forward gets abandoned the moment a task seems to need it.
 */
export const PROJECT_SCOPE_INSTRUCTION =
  "Project scope: this session's working folder is your workspace.\n\n" +
  "You may READ anything you need outside it — a toolchain, an SDK, a system header, another " +
  "checkout. But do not CREATE, MODIFY, MOVE or DELETE any file outside that folder. Keep build " +
  "output, scratch files and notes inside it.\n\n" +
  "If a task genuinely needs a change outside the working folder, say what you need and why, and " +
  "let the user decide — do not make the change and report it afterwards. This is a rule of the " +
  "permission mode this chat is in, not a preference of yours to weigh against the task."

/**
 * The project-scope SECTION for a permission mode — the instruction in every mode except `yolo`,
 * and `undefined` (i.e. nothing at all, via the composition filter) in `yolo`.
 *
 * Takes the RESOLVED mode: `resolveSessionConfig` has already applied the narrowing keystone, so a
 * child of a non-yolo parent can never resolve to `yolo` and can never lose this section.
 */
export const projectScopeSection = (mode: PermissionMode): string | undefined =>
  mode === "yolo" ? undefined : PROJECT_SCOPE_INSTRUCTION

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
  /** The project-scope rule (already resolved via `projectScopeSection`); absent in `yolo`. */
  readonly projectScope?: string
  /** The immutable kernel base context (environment, tools, skills) — composed LAST. */
  readonly base?: string
}

/**
 * The ORDERED, non-empty system-prompt parts. The per-model pre-prompt sits immediately after the
 * persona baseline; every other part keeps its existing position, so with no pre-prompt the output is
 * byte-identical to the pre-feature array. Uses the exact same non-empty predicate the runner used
 * inline (`part !== undefined && part.length > 0`).
 *
 * ⚠️ PLACEMENT of `projectScope`: immediately BEFORE `base`, i.e. after everything a persona, a
 * user override or an agent prompt can say, and still inside the kernel material that closes the
 * prompt. Two reasons, in order of weight. (1) It is a KERNEL constraint, not task material — the
 * same family as the base context, and grouping it there is what lets a session inspecting its own
 * prompt tell "what the product requires" from "what this chat asked for". (2) An agent's own
 * system prompt (`agentSystem`) is authored per agent and can be edited by the user; sitting after
 * it means a well-meaning agent prompt cannot bury the rule under later instructions. `base` stays
 * last, exactly as the header above documents.
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
    parts.projectScope,
    parts.base,
  ].filter((part): part is string => part !== undefined && part.length > 0)
