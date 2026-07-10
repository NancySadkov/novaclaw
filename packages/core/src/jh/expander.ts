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
  write_file: "write_file{path, content} — OVERWRITES the whole file; give a file's COMPLETE content in ONE call (a later write_file to the same path erases the earlier one — never build a file across multiple write_file calls)",
  edit_file: "edit_file{path, old_string, new_string} — replace ONE exact occurrence of old_string with new_string (old_string must appear EXACTLY ONCE in the file); PREFER this over write_file for a localized fix — faster and it can't corrupt the rest of the file. Use write_file only for a NEW file or a full rewrite.",
  read_file: "read_file{path}",
  run: "run{command} — execute a shell command (compile, run a program, etc.)",
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
