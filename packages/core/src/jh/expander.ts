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
  write_file: "write_file{path, content}",
  read_file: "read_file{path}",
  run: "run{command}",
  note: "note{text}",
}

function modeLine(allowDecomposition: boolean, mustDecompose: boolean): string {
  if (mustDecompose) {
    return 'This step is too complex to be atomic — you MUST decompose it into 2–8 substeps. Set size to "needs_decomposition", fill `substeps`, and emit NO tool/args on this step.'
  }
  if (!allowDecomposition) {
    return 'You may NOT decompose this step (maximum planning depth reached). Emit an ATOMIC step: size "atomic", exactly ONE tool with its args, and a runnable check.'
  }
  return 'Decide: if this step is a single tool call, emit an ATOMIC step (size "atomic", one tool + args, a runnable check). If it is too big for one tool call, emit size "needs_decomposition" with 2–8 substeps and NO tool/args.'
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
}): PromptPair {
  const toolTable = input.toolNames.map((n) => `  - ${TOOL_ARGS[n] ?? `${n}{...}`}`).join("\n")
  const environmentBlock = input.environment ? ["", "Execution environment:", input.environment] : []
  const system = [
    "You are the planning/expansion component of a deterministic execution harness. You do NOT do the whole task — you fill a small fixed schema for the CURRENT step only, and the harness runs the loop.",
    "",
    modeLine(input.allowDecomposition, input.mustDecompose),
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
 *  that — it needs the parsed draft to repair). */
export function parseReply(text: string): { readonly ok: true; readonly draft: JhStep.StepDraft } | { readonly ok: false; readonly issue: string } {
  const extracted = JhExtract.extractJsonObject(text)
  if (!extracted.ok) return { ok: false, issue: `${extracted.failure.reason}: ${extracted.failure.detail}` }
  try {
    const draft = Schema.decodeUnknownSync(JhStep.StepDraft)(JhStep.coerceDraftShape(extracted.value))
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

export function dataflowRepairReminder(issues: ReadonlyArray<JhDataflow.Issue>): string {
  const lines = issues.map((i) => `  - ${i.code} at substep ${i.step} (artifact "${i.artifact}")`)
  return [
    "The harness REJECTED this decomposition — its declared dataflow is broken:",
    ...lines,
    "Fix it: every substep's `consumes` must be produced by an EARLIER substep or already exist, and no artifact may be produced twice. Re-emit the whole step.",
  ].join("\n")
}
