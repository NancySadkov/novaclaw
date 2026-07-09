export * as JhStep from "./step"

// jh (Juvenile Harness) — the Step wire schema (jh.md §4) plus structural validation the codec
// itself cannot express. The model fills this fixed schema for the CURRENT step and either emits an
// atomic single-tool-call leaf or a decomposition into substeps (§3, the recursive primitive). The
// codec decodes TOLERANTLY — an atomic step carrying substeps still decodes; `structuralIssues` is
// what catches the contradiction, because the engine needs the parsed draft to build its repair
// re-prompt. Design decisions D4 (a machine-runnable `check` alongside human `success`) and D11 (the
// `args` payload for atomic leaves) live here.

import { Schema } from "effect"

export const StepID = Schema.String.pipe(Schema.brand("Jh.StepID"))
export type StepID = typeof StepID.Type

export const ArtifactType = Schema.Literals(["file", "text", "note", "command_output"])
export type ArtifactType = typeof ArtifactType.Type

export const ArtifactRef = Schema.Struct({
  // slug; validated in structuralIssues, NOT in the codec (keep decode tolerant)
  id: Schema.String,
  type: ArtifactType,
})
export type ArtifactRef = typeof ArtifactRef.Type

// D4 — the machine-runnable check. Mirrors ResponseFormat's tagged-union idiom (llm messages.ts:264).
export const Check = Schema.Union([
  // pass = exit 0
  Schema.Struct({
    type: Schema.Literal("compile"),
    command: Schema.String,
    timeoutMs: Schema.optional(Schema.Number),
  }),
  // pass = exit 0 (+ output contains `expect` when given)
  Schema.Struct({
    type: Schema.Literal("run"),
    command: Schema.String,
    expect: Schema.optional(Schema.String),
    timeoutMs: Schema.optional(Schema.Number),
  }),
  // pass = trimmed output === expected
  Schema.Struct({
    type: Schema.Literal("output_equals"),
    command: Schema.String,
    expected: Schema.String,
    timeoutMs: Schema.optional(Schema.Number),
  }),
  Schema.Struct({ type: Schema.Literal("file_exists"), path: Schema.String }),
  // pass = every declared produce was committed with non-empty content
  Schema.Struct({ type: Schema.Literal("artifact_present") }),
]).pipe(Schema.toTaggedUnion("type"))
export type Check = typeof Check.Type

export const Size = Schema.Literals(["atomic", "needs_decomposition"])
export type Size = typeof Size.Type

export const DifficultyPrior = Schema.Literals(["trivial", "moderate", "hard"])
export type DifficultyPrior = typeof DifficultyPrior.Type

// The model-emitted Step (jh.md §4 + D11's `args`). Recursive via substeps. TOLERANCE (jh.md §12,
// measured on qwen 2026-07-09): every optional field also accepts `null` — small models emit
// `"substeps": null` for absent fields instead of omitting them — and `success` is OPTIONAL (it is
// human legibility; the machine gate is `check` per D4, and weak models frequently drop it). Downstream
// `?? default` handles both null and undefined uniformly.
export interface StepDraft {
  readonly goal: string
  readonly research_needed?: boolean | null
  readonly consumes?: ReadonlyArray<ArtifactRef> | null
  readonly produces?: ReadonlyArray<ArtifactRef> | null
  readonly tool?: string | null
  readonly args?: Readonly<Record<string, unknown>> | null
  readonly size: "atomic" | "needs_decomposition"
  readonly difficulty_prior?: DifficultyPrior | null
  readonly success?: string | null
  readonly check?: Check | null
  readonly assumptions?: ReadonlyArray<string> | null
  readonly substeps?: ReadonlyArray<StepDraft> | null
}
export const StepDraft = Schema.Struct({
  goal: Schema.String,
  research_needed: Schema.optional(Schema.NullOr(Schema.Boolean)),
  consumes: Schema.optional(Schema.NullOr(Schema.Array(ArtifactRef))),
  produces: Schema.optional(Schema.NullOr(Schema.Array(ArtifactRef))),
  tool: Schema.optional(Schema.NullOr(Schema.String)),
  args: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  size: Size,
  difficulty_prior: Schema.optional(Schema.NullOr(DifficultyPrior)),
  success: Schema.optional(Schema.NullOr(Schema.String)),
  check: Schema.optional(Schema.NullOr(Check)),
  assumptions: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  substeps: Schema.optional(Schema.NullOr(Schema.Array(Schema.suspend((): Schema.Codec<StepDraft> => StepDraft)))),
})

export const ARTIFACT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

export interface StructuralIssue {
  readonly severity: "error" | "warning"
  readonly code:
    | "empty_goal"
    | "atomic_with_substeps"
    | "compound_without_substeps"
    | "atomic_missing_tool"
    | "compound_with_tool"
    | "atomic_missing_args"
    | "atomic_missing_check"
    | "bad_artifact_id"
  readonly path: string // e.g. "substeps[2].produces[0]"
  readonly detail?: string
}

/**
 * Pre-decode shape tolerance (jh.md §12, measured on qwen 2026-07-09): small models emit a single
 * `{id,type}` object where an array is expected (`produces`/`consumes`/`assumptions`) and occasionally a
 * lone `substeps` object. Coerce those to one-element arrays so the codec accepts them; recurse into
 * substeps. Pure and total — a non-object passes through unchanged.
 */
export function coerceDraftShape(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(coerceDraftShape)
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  for (const key of ["consumes", "produces", "assumptions"]) {
    if (out[key] != null && !Array.isArray(out[key])) out[key] = [out[key]]
  }
  if (out.substeps != null && !Array.isArray(out.substeps)) out.substeps = [out.substeps]
  if (Array.isArray(out.substeps)) out.substeps = out.substeps.map(coerceDraftShape)
  return out
}

const join = (base: string, seg: string): string => (base === "" ? seg : `${base}.${seg}`)

const hasTool = (draft: StepDraft): boolean =>
  typeof draft.tool === "string" && draft.tool.trim() !== ""

/**
 * Pure, total, recursive. Codec-valid drafts can still be structurally wrong (an atomic step with
 * substeps, a compound step with a tool, a bad artifact-id slug) — this catches that. The engine
 * treats any "error" severity as grounds to reject-and-repair; "warning" (missing check on a leaf) it
 * tolerates by substituting an `artifact_present` check.
 */
export function structuralIssues(draft: StepDraft, path: string = ""): ReadonlyArray<StructuralIssue> {
  const issues: StructuralIssue[] = []
  const atomic = draft.size === "atomic"
  const substeps = draft.substeps ?? []

  if (draft.goal.trim() === "") {
    issues.push({ severity: "error", code: "empty_goal", path })
  }

  if (atomic) {
    if (substeps.length > 0) {
      issues.push({ severity: "error", code: "atomic_with_substeps", path })
    }
    if (!hasTool(draft)) {
      issues.push({ severity: "error", code: "atomic_missing_tool", path })
    }
    if (draft.args == null) {
      issues.push({ severity: "error", code: "atomic_missing_args", path })
    }
    if (draft.check == null) {
      // The engine substitutes an `artifact_present` check, so this is a warning, not an error.
      issues.push({ severity: "warning", code: "atomic_missing_check", path })
    }
  } else {
    if (substeps.length === 0) {
      issues.push({ severity: "error", code: "compound_without_substeps", path })
    }
    if (hasTool(draft)) {
      issues.push({ severity: "error", code: "compound_with_tool", path })
    }
  }

  const checkRefs = (refs: ReadonlyArray<ArtifactRef> | null | undefined, which: "consumes" | "produces") => {
    refs?.forEach((ref, i) => {
      if (!ARTIFACT_ID_PATTERN.test(ref.id)) {
        issues.push({
          severity: "error",
          code: "bad_artifact_id",
          path: join(path, `${which}[${i}]`),
          detail: ref.id,
        })
      }
    })
  }
  checkRefs(draft.consumes, "consumes")
  checkRefs(draft.produces, "produces")

  substeps.forEach((sub, i) => {
    issues.push(...structuralIssues(sub, join(path, `substeps[${i}]`)))
  })

  return issues
}
