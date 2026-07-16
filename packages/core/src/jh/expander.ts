export * as JhExpander from "./expander"

// jh — the model-facing prompts + reply parser for the expander (jh.md §3 macro-expander, §4 schema).
// PURE string builders + a tolerant parser; the engine injects the actual LLM call (D6), so nothing
// here imports an LLM client. §10's load-bearing finding: keep introspection STRUCTURED and short —
// qwen-class models need imperative, not prose. Structural validation is the ENGINE's job (it needs
// the parsed draft to build repair prompts), so parseReply only does extract → codec-decode.

import { Schema } from "effect"
import { JhStep } from "./step"
import { JhExtract } from "./extract"
import type { JhDataflow } from "./dataflow"

export interface PromptPair {
  readonly system: string
  readonly user: string
}

const TOOL_ARGS: Record<string, string> = {
  write_file: "write_file{path, content} — CREATE a file that does not exist yet (OVERWRITES the whole file). Use it ONLY for the first creation of a file; to change or extend an EXISTING file use edit_file. Rewriting an existing file with write_file discards work you already verified and reintroduces bugs.",
  // improve17 L2: the beat-run primitive — bulk artifacts grow in verified increments instead of
  // being regenerated whole.
  append_file: "append_file{path, content} — ADD content to the END of a file (creates it if missing; a blank line separates increments). The RIGHT tool for growing a long document section by section — never re-send text the file already contains.",
  edit_file: "edit_file{path, old_string, new_string} — replace ONE exact occurrence of old_string with new_string (old_string must appear EXACTLY ONCE in the file). This is the DEFAULT way to change an existing file: add a function, fix a line — surgical, fast, and it cannot corrupt the untouched rest of the file.",
  // improve16/17 anatomy: replace_lines previously had NO entry here, so its schema rendered as
  // "replace_lines{...}" and the model learned the arg shape only from rejections (8-17 arg-shape
  // fails per wall-55 run). The schema belongs in the table.
  replace_lines: "replace_lines{path, first_line, last_line, new_content} — replace the line RANGE first_line..last_line (1-based, inclusive, from the `N→` numbers in the workspace view) with new_content. The reliable way to fix specific lines: you do NOT reproduce the old text, the numbered lines are ground truth.",
  read_file: "read_file{path}",
  run: "run{command} — execute a shell command (compile, run a program, etc.)",
  note: "note{text}",
  git_revert: "git_revert{path?} — roll a file (or the whole tree if no path) back to the last VERIFIED checkpoint. Use when an edit_file made the file worse and you cannot repair it — revert, then try a different edit.",
}

function modeLine(allowDecomposition: boolean, mustDecompose: boolean, lazyPlan: boolean): string {
  // improve3 P3a: LAZY planning asks for the immediate TOP-LEVEL phases ONLY (no up-front nesting) — a smaller
  // reply (harder to malform, attacking I3) that also defers depth. Each phase re-plans itself when reached.
  const howMany = lazyPlan
    ? 'it into its immediate TOP-LEVEL phases ONLY: 3–7 substeps, each ONE sentence of goal (plus its check when obvious). Do NOT nest sub-substeps inside them — each phase is planned in detail WHEN IT IS REACHED, with everything already built available as context'
    : 'it into 2–8 substeps'
  if (mustDecompose) {
    return `This step is too complex to be atomic — you MUST decompose ${howMany}. Set size to "needs_decomposition", fill \`substeps\`, and emit NO tool/args on this step.`
  }
  if (!allowDecomposition) {
    return 'You may NOT decompose this step (maximum planning depth reached). Emit an ATOMIC step: size "atomic", exactly ONE tool with its args, and a runnable check.'
  }
  return `Decide: if this step is a single tool call, emit an ATOMIC step (size "atomic", one tool + args, a runnable check). If it is too big for one tool call, emit size "needs_decomposition" and decompose ${howMany}, with NO tool/args.`
}

export function introspectPrompt(input: {
  readonly taskGoal: string
  readonly stepGoal: string
  readonly context: string
  readonly toolNames: ReadonlyArray<string>
  readonly allowDecomposition: boolean
  readonly mustDecompose: boolean
  readonly formatReminder?: string
  /** Harness-owned execution-environment description (shell, cwd, fresh-shell/PATH mechanics). */
  readonly environment?: string
  /** improve3 P3a: lazy planning — ask for top-level phases only (default true; false = wave-2 wording). */
  readonly lazyPlan?: boolean
}): PromptPair {
  const toolTable = input.toolNames.map((n) => `  - ${TOOL_ARGS[n] ?? `${n}{...}`}`).join("\n")
  const environmentBlock = input.environment ? ["", "Execution environment:", input.environment] : []
  const system = [
    "You are the planning/expansion component of a deterministic execution harness. You do NOT do the whole task — you fill a small fixed schema for the CURRENT step only, and the harness runs the loop.",
    "",
    modeLine(input.allowDecomposition, input.mustDecompose, input.lazyPlan !== false),
    "",
    "Step schema fields:",
    "  - goal: one sentence — what THIS step achieves.",
    "  - size: \"atomic\" (one tool call) or \"needs_decomposition\" (a list of substeps).",
    "  - tool + args: for an atomic step only — the single tool and its arguments.",
    '  - consumes / produces: typed artifact handles this step READS / WRITES. Each is an OBJECT {"id": "add.c", "type": "file"} — NOT a bare string. type is one of: file | text | note | command_output. Every consumed id must be produced by an EARLIER substep or already exist, or the harness REJECTS the plan.',
    "  - success: one short sentence — what 'done' means. Include it on EVERY step, atomic AND compound.",
    "  - check: the machine-runnable gate (see below).",
    "  - difficulty_prior: your guess — \"trivial\" | \"moderate\" | \"hard\" (a hint only; the harness measures the real difficulty).",
    "  - assumptions: what you are taking for granted.",
    "  - substeps: child steps (present only when decomposing).",
    "",
    "check vocabulary (pick one for an atomic step):",
    '  - {"type":"compile","command":"gcc -c add.c"}    → passes on exit 0',
    '  - {"type":"run","command":"./t","expect":"999"}   → exit 0 (+ output contains expect, if given)',
    '  - {"type":"output_equals","command":"./pi","expected":"3.14"} → trimmed output equals expected',
    '  - {"type":"file_exists","path":"add.c"}',
    '  - {"type":"artifact_present"}                      → the declared produces were written',
    "",
    "Available tools (an atomic step calls exactly ONE):",
    toolTable,
    ...environmentBlock,
    "",
    "Every step object needs at least `goal`, `size`, and `success`; a compound step also needs `substeps`. OMIT any field you are not using — do NOT write `null`.",
    "",
    "Output protocol: think briefly if you must, then output EXACTLY ONE ```json fenced object and NOTHING after it.",
  ].join("\n")

  const userParts = [
    input.context,
    "",
    `Fill the Step schema for the current step: "${input.stepGoal}". Output exactly one \`\`\`json object.`,
  ]
  if (input.formatReminder) userParts.push("", input.formatReminder)
  return { system, user: userParts.join("\n") }
}

/** extract the JSON object → decode against the Step codec. NO structural validation (the engine owns
 *  that — it needs the parsed draft to repair). improve12.1: `fallbackGoal` lets shape-coercion adopt
 *  the caller-known goal for tool-call-shaped replies (§12 tolerance — repair before rejecting). */
/** How many lines of plan we ask for — and mechanically enforce (improve19: summarisation is a
 *  BOUNDED ASK, not a third call; a plan longer than the step it plans is a new context problem). */
export const PLAN_MAX_LINES = 8

/**
 * improve19 — the THINK stage prompt (`notes/jh-think-stage.md`). Deliberately schema-FREE: this is
 * the one call in jh that must NOT produce JSON. It gets the same context the introspect gets and
 * returns a short plan in plain language, which is then pre-prompted into the DO call.
 *
 * The mode split is the whole design: reasoning here (where a runaway costs only this call and its
 * output IS prose), schema-filling there (where a runaway costs the step).
 */
export function thinkPrompt(input: {
  readonly taskGoal: string
  readonly stepGoal: string
  readonly context: string
  readonly kind: "decompose" | "recover" | "atomic"
  readonly environment?: string
}): PromptPair {
  const focus =
    input.kind === "decompose"
      ? "Decide how this step should BREAK DOWN: name the 3-7 phases, in order, and say what makes each one verifiable."
      : input.kind === "recover"
        ? "The last attempt FAILED and the failure is quoted in the context. Diagnose the ACTUAL cause from the evidence, then name the ONE next action that is genuinely different from what just failed — do not repeat it."
        : "Decide the ONE next concrete action for this step, and what would prove it worked."
  return {
    system:
      "You are the PLANNER for an automated build harness. You think; a separate executor acts. " +
      "Reason about the step and answer with a short plan in PLAIN LANGUAGE — no JSON, no code blocks, no tool call. " +
      `At most ${PLAN_MAX_LINES} short lines. Be concrete and specific to THIS workspace; do not restate the task.`,
    user: [
      `TASK: ${input.taskGoal}`,
      `THIS STEP: ${input.stepGoal}`,
      input.environment ? `\nENVIRONMENT:\n${input.environment}` : "",
      `\nWORKSPACE + HISTORY:\n${input.context}`,
      `\n${focus}`,
      `\nAnswer in at most ${PLAN_MAX_LINES} short lines of plain language.`,
    ]
      .filter(Boolean)
      .join("\n"),
  }
}

/** Trim a plan to its first PLAN_MAX_LINES non-empty lines and strip any code fences the planner
 *  emitted anyway — the DO call must never receive something that looks like a schema to copy. */
export function boundPlan(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
  return cleaned.slice(0, PLAN_MAX_LINES).join("\n").slice(0, 1500)
}

export function parseReply(text: string, opts?: { readonly fallbackGoal?: string }): { readonly ok: true; readonly draft: JhStep.StepDraft } | { readonly ok: false; readonly issue: string } {
  const extracted = JhExtract.extractJsonObject(text)
  if (!extracted.ok) {
    // improve3 P2b: surface the LOCATED failure (position + snippet + likely cause) so the retry reminder is
    // actionable — "unbalanced near '…{"goal":"…' (truncated → shorter plan)" instead of just "unbalanced".
    const f = extracted.failure
    const parts = [`${f.reason}: ${f.detail}`]
    if (f.position !== undefined) parts.push(`near position ${f.position}`)
    if (f.snippet) parts.push(`context: ${f.snippet}`)
    if (f.cause) parts.push(`likely cause: ${f.cause}`)
    return { ok: false, issue: parts.join(" — ") }
  }
  try {
    const draft = Schema.decodeUnknownSync(JhStep.StepDraft)(JhStep.coerceDraftShape(extracted.value, opts?.fallbackGoal))
    return { ok: true, draft }
  } catch (e) {
    // The SchemaError message names the failing field on an `at ["field"]` line — collapse it to one
    // line so the engine can feed it back as a format reminder.
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, issue: msg.replace(/\s+/g, " ").trim().slice(0, 300) }
  }
}

/** JSON Schema for a StepDraft (strict-emission mode / Phase 11 A/B). Mirrors tool.ts:220 $defs handling. */
export function stepJsonSchema(): object {
  const document = Schema.toJsonSchemaDocument(JhStep.StepDraft)
  if (Object.keys(document.definitions).length === 0) return document.schema
  return { ...document.schema, $defs: document.definitions }
}

/** Goal-achievement verification (owner directive): after a step's mechanical check passes, the model
 *  judges whether the step's GOAL was ACTUALLY achieved given the current workspace — a write_file that
 *  passed `artifact_present` did NOT compile+run+verify. Catches the "false done". Reply is a tiny JSON
 *  `{"achieved": bool, "missing": "…"}`. */
export function goalCheckPrompt(input: { readonly goal: string; readonly workspace: string; readonly lastOutput?: string }): PromptPair {
  const system = [
    "You are the completion checker of a deterministic execution harness.",
    "Given ONE step's GOAL, the CURRENT working-directory files, and the most recent program OUTPUT, judge whether THIS STEP's OWN goal is objectively achieved. Judge ONLY what this goal asks for — no more, no less:",
    "  - a goal to WRITE or EDIT a source file → achieved once the file exists with SUBSTANTIAL content toward the goal (a full function body / program body, not an empty stub or a file cut off mid-token). Do NOT reject it for SUSPECTED compile errors, undefined names, or logic bugs — a later COMPILE step reports those precisely and the harness fixes them; your only job here is that a real, non-truncated source was written.",
    "  - a goal to COMPILE/BUILD → achieved once the compiled output exists on disk (e.g. an .exe/.o is listed, even shown as a <compiled binary …> placeholder).",
    "  - a goal to RUN / produce a correct RESULT → achieved only if the program actually ran AND the shown output is CORRECT. If the goal names an expected value (e.g. digits of a constant), CHECK the output against what you know to be the true value — a program that runs but prints wrong digits is NOT achieved.",
    "Do NOT demand steps this goal does not ask for — a 'compile' goal does NOT require also running. But do NOT accept a mere source file when the goal asks for a built or correct artifact, and do NOT accept an empty/absent output when the goal asks for a computed result.",
    'Output EXACTLY ONE ```json object: {"achieved": true|false, "missing": "one short phrase — what THIS goal still needs, empty if achieved", "evidence": "when achieved is true, a VERBATIM quote copied EXACTLY from the working-directory files or the program output shown above that proves it — the literal text, not a paraphrase or a claim"}. Nothing else.',
  ].join("\n")
  const outputBlock = input.lastOutput !== undefined ? `\n\n# Most recent program output (stdout)\n\`\`\`\n${input.lastOutput.length > 4000 ? input.lastOutput.slice(0, 4000) + "\n…[truncated]…" : input.lastOutput || "(no output captured)"}\n\`\`\`` : ""
  const user = `# Goal\n${input.goal}\n\n# Working directory\n${input.workspace}${outputBlock}\n\nIs the goal fully achieved? Output one json object.`
  return { system, user }
}

export function parseGoalCheck(text: string): { readonly achieved: boolean; readonly missing: string; readonly evidence?: string } {
  const extracted = JhExtract.extractJsonObject(text)
  if (!extracted.ok || typeof extracted.value !== "object" || extracted.value === null) return { achieved: false, missing: "unparseable goal check" }
  const v = extracted.value as Record<string, unknown>
  return {
    achieved: v.achieved === true,
    missing: typeof v.missing === "string" ? v.missing : "",
    evidence: typeof v.evidence === "string" ? v.evidence : undefined,
  }
}

export function dataflowRepairReminder(issues: ReadonlyArray<JhDataflow.Issue>): string {
  const lines = issues.map((i) => `  - ${i.code} at substep ${i.step} (artifact "${i.artifact}")`)
  return [
    "The harness REJECTED this decomposition — its declared dataflow is broken:",
    ...lines,
    "Fix it: every substep's `consumes` must be produced by an EARLIER substep or already exist, and no artifact may be produced twice. Re-emit the whole step.",
  ].join("\n")
}
