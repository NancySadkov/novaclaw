export * as ToolRouter from "./tool-router"

import { JsonSchema, Option, Schema } from "effect"
import { JsonSchemaValidate } from "./util/json-schema-validate"

export const Capability = Schema.Literals([
  "tools.serialize",
  "document.parse.native",
  "document.parse.layout",
  "vision.screen",
  "vision.ground",
  "audio.transcribe",
  "image.generate",
  "image.edit",
])
export type Capability = typeof Capability.Type

export const RiskClass = Schema.Literals(["read", "idempotent-write", "non-idempotent", "external-unknown"])
export type RiskClass = typeof RiskClass.Type

export const ActionIntent = Schema.Struct({
  goal: Schema.NonEmptyString,
  capability: Capability,
  selectedTool: Schema.optional(Schema.NonEmptyString),
  knownArguments: Schema.Record(Schema.String, Schema.Unknown),
  missingArguments: Schema.Array(Schema.NonEmptyString),
  expectedEvidence: Schema.NonEmptyArray(Schema.NonEmptyString),
  risk: RiskClass,
  /** Absolute Unix epoch milliseconds. The harness supplies `nowMs`; the router never edits this. */
  deadline: Schema.Int.check(Schema.isGreaterThan(0)),
})
export type ActionIntent = typeof ActionIntent.Type

export const Invoke = Schema.Struct({
  type: Schema.Literal("invoke"),
  tool: Schema.NonEmptyString,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
})
export type Invoke = typeof Invoke.Type

export const NeedParameters = Schema.Struct({
  type: Schema.Literal("need_parameters"),
  fields: Schema.NonEmptyArray(Schema.NonEmptyString),
})
export type NeedParameters = typeof NeedParameters.Type

export const Abstain = Schema.Struct({
  type: Schema.Literal("abstain"),
  reason: Schema.NonEmptyString,
})
export type Abstain = typeof Abstain.Type

export const RouterResult = Schema.Union([Invoke, NeedParameters, Abstain]).pipe(Schema.toTaggedUnion("type"))
export type RouterResult = typeof RouterResult.Type

export interface ToolCandidate {
  readonly name: string
  readonly capability: Capability
  readonly risk: RiskClass
  readonly inputSchema: JsonSchema.JsonSchema
}

export type IssueCode =
  | "invalid_intent"
  | "invalid_result"
  | "empty_shortlist"
  | "shortlist_too_large"
  | "duplicate_tool"
  | "invalid_tool_name"
  | "deadline_expired"
  | "duplicate_missing_argument"
  | "argument_both_known_and_missing"
  | "selected_tool_not_disclosed"
  | "selected_tool_capability_mismatch"
  | "selected_tool_risk_mismatch"
  | "result_tool_not_disclosed"
  | "result_tool_conflicts_with_selection"
  | "result_tool_capability_mismatch"
  | "result_tool_risk_mismatch"
  | "invoke_with_missing_arguments"
  | "known_argument_changed"
  | "invalid_tool_schema"
  | "invalid_arguments"
  | "parameters_not_missing"
  | "duplicate_parameter"

export interface Issue {
  readonly code: IssueCode
  readonly path?: string
  readonly detail?: string
}

export type Validation =
  | { readonly ok: true; readonly intent: ActionIntent; readonly result: RouterResult }
  | { readonly ok: false; readonly issues: ReadonlyArray<Issue> }

export const MAX_SHORTLIST = 8

const DECODE_OPTIONS = { errors: "all", onExcessProperty: "error", propertyOrder: "original" } as const
const decodeIntent = Schema.decodeUnknownOption(ActionIntent, DECODE_OPTIONS)
const decodeResult = Schema.decodeUnknownOption(RouterResult, DECODE_OPTIONS)

export function validate(input: {
  readonly intent: unknown
  readonly result: unknown
  readonly shortlist: ReadonlyArray<ToolCandidate>
  readonly nowMs: number
}): Validation {
  const intent = Option.getOrUndefined(decodeIntent(input.intent))
  const result = Option.getOrUndefined(decodeResult(input.result))
  const issues: Issue[] = []
  if (intent === undefined) issues.push({ code: "invalid_intent" })
  if (result === undefined) issues.push({ code: "invalid_result" })
  if (input.shortlist.length === 0) issues.push({ code: "empty_shortlist" })
  if (input.shortlist.length > MAX_SHORTLIST)
    issues.push({ code: "shortlist_too_large", detail: String(input.shortlist.length) })

  const names = new Set<string>()
  for (const tool of input.shortlist) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(tool.name)) issues.push({ code: "invalid_tool_name", detail: tool.name })
    if (names.has(tool.name)) issues.push({ code: "duplicate_tool", detail: tool.name })
    names.add(tool.name)
  }
  if (intent === undefined || result === undefined) return { ok: false, issues }

  if (intent.deadline <= input.nowMs) issues.push({ code: "deadline_expired" })
  const missing = new Set(intent.missingArguments)
  if (missing.size !== intent.missingArguments.length) issues.push({ code: "duplicate_missing_argument" })
  for (const name of Object.keys(intent.knownArguments))
    if (missing.has(name)) issues.push({ code: "argument_both_known_and_missing", path: name })
  if (intent.selectedTool !== undefined) {
    const selected = input.shortlist.find((tool) => tool.name === intent.selectedTool)
    if (selected === undefined) issues.push({ code: "selected_tool_not_disclosed", detail: intent.selectedTool })
    else if (selected.capability !== intent.capability)
      issues.push({ code: "selected_tool_capability_mismatch", detail: selected.name })
    else if (selected.risk !== intent.risk) issues.push({ code: "selected_tool_risk_mismatch", detail: selected.name })
  }

  if (result.type === "invoke") {
    const tool = input.shortlist.find((candidate) => candidate.name === result.tool)
    if (tool === undefined) issues.push({ code: "result_tool_not_disclosed", detail: result.tool })
    if (intent.selectedTool !== undefined && result.tool !== intent.selectedTool)
      issues.push({ code: "result_tool_conflicts_with_selection", detail: result.tool })
    if (tool !== undefined && tool.capability !== intent.capability)
      issues.push({ code: "result_tool_capability_mismatch", detail: result.tool })
    if (tool !== undefined && tool.risk !== intent.risk)
      issues.push({ code: "result_tool_risk_mismatch", detail: result.tool })
    if (intent.missingArguments.length > 0)
      issues.push({ code: "invoke_with_missing_arguments", detail: intent.missingArguments.join(",") })
    for (const [name, value] of Object.entries(intent.knownArguments)) {
      if (!(name in result.arguments) || !deepEqual(value, result.arguments[name]))
        issues.push({ code: "known_argument_changed", path: name })
    }
    if (tool !== undefined) {
      // The owned validator (`util/json-schema-validate.ts`): the same verdict and the same
      // `instancePath:keyword` list ajv gave, held to a recording of ajv's answers, without a
      // `new Function` compiler on the path that consumes model output.
      if (isAsyncSchema(tool.inputSchema)) {
        issues.push({ code: "invalid_tool_schema", detail: "async JSON Schemas are not supported" })
      } else {
        try {
          const outcome = JsonSchemaValidate.validate(tool.inputSchema, result.arguments)
          if (!outcome.ok)
            issues.push({
              code: "invalid_arguments",
              detail: outcome.errors.map((error) => `${error.instancePath || "/"}:${error.keyword}`).join(","),
            })
        } catch (error) {
          issues.push({ code: "invalid_tool_schema", detail: error instanceof Error ? error.message : String(error) })
        }
      }
    }
  } else if (result.type === "need_parameters") {
    const unique = new Set(result.fields)
    if (unique.size !== result.fields.length) issues.push({ code: "duplicate_parameter" })
    if (unique.size !== missing.size || [...unique].some((field) => !missing.has(field)))
      issues.push({ code: "parameters_not_missing", detail: result.fields.join(",") })
  }

  return issues.length === 0 ? { ok: true, intent, result } : { ok: false, issues }
}

function isAsyncSchema(schema: JsonSchema.JsonSchema): boolean {
  return typeof schema === "object" && schema !== null && "$async" in schema && schema.$async === true
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((v, i) => deepEqual(v, right[i]))
    )
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && deepEqual(a[key], b[key]))
}
