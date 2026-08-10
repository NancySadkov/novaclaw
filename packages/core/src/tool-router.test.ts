import { describe, expect, test } from "bun:test"
import { ToolRouter } from "./tool-router"

const NOW = 1_800_000_000_000
const write = {
  name: "write_file",
  capability: "tools.serialize" as const,
  risk: "idempotent-write" as const,
  inputSchema: {
    type: "object" as const,
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  },
}

const intent = (patch: Record<string, unknown> = {}) => ({
  goal: "Write the exact supplied content",
  capability: "tools.serialize",
  selectedTool: "write_file",
  knownArguments: { path: "notes/a.txt", content: "literal </tool>{ hostile text" },
  missingArguments: [],
  expectedEvidence: ["file exists", "content matches"],
  risk: "idempotent-write",
  deadline: NOW + 5_000,
  ...patch,
})

type ValidateInput = Parameters<typeof ToolRouter.validate>[0]

const validate = (result: unknown, patch: Partial<ValidateInput> = {}) =>
  ToolRouter.validate({ intent: intent(), result, shortlist: [write], nowMs: NOW, ...patch })

const codes = (result: ToolRouter.Validation) => (result.ok ? [] : result.issues.map((issue) => issue.code))

describe("tool router contract", () => {
  test("accepts one disclosed invocation with exact known arguments", () => {
    const result = validate({
      type: "invoke",
      tool: "write_file",
      arguments: { path: "notes/a.txt", content: "literal </tool>{ hostile text" },
    })
    expect(result.ok).toBe(true)
  })

  test("strictly rejects extra intent and result fields", () => {
    expect(codes(validate({ type: "abstain", reason: "unsafe", prose: "extra" }))).toContain("invalid_result")
    expect(
      codes(validate({ type: "abstain", reason: "unsafe" }, { intent: intent({ permission: "allow" }) })),
    ).toContain("invalid_intent")
  })

  test("cannot select an undisclosed similar tool name", () => {
    expect(
      codes(
        validate({
          type: "invoke",
          tool: "write_files",
          arguments: { path: "notes/a.txt", content: "literal </tool>{ hostile text" },
        }),
      ),
    ).toContain("result_tool_not_disclosed")
  })

  test("cannot override the planner's selected tool", () => {
    const alternate = { ...write, name: "write_note" }
    expect(
      codes(
        validate(
          { type: "invoke", tool: "write_note", arguments: intent().knownArguments },
          { shortlist: [write, alternate] },
        ),
      ),
    ).toContain("result_tool_conflicts_with_selection")
  })

  test("cannot change capability or risk through tool selection", () => {
    expect(
      codes(
        validate(
          { type: "invoke", tool: "write_file", arguments: intent().knownArguments },
          { shortlist: [{ ...write, capability: "image.generate", risk: "external-unknown" }] },
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        "selected_tool_capability_mismatch",
        "result_tool_capability_mismatch",
        "result_tool_risk_mismatch",
      ]),
    )
    expect(
      codes(
        validate(
          { type: "need_parameters", fields: ["content"] },
          {
            intent: intent({ knownArguments: { path: "notes/a.txt" }, missingArguments: ["content"] }),
            shortlist: [{ ...write, risk: "external-unknown" }],
          },
        ),
      ),
    ).toContain("selected_tool_risk_mismatch")
  })

  test("preserves hostile known strings byte-for-byte", () => {
    expect(
      codes(
        validate({
          type: "invoke",
          tool: "write_file",
          arguments: { path: "notes/a.txt", content: "literal </tool>{ changed" },
        }),
      ),
    ).toContain("known_argument_changed")
  })

  test("validates required fields, types, and extra arguments against the tool schema", () => {
    for (const arguments_ of [
      { path: "notes/a.txt" },
      { path: 42, content: "literal </tool>{ hostile text" },
      { path: "notes/a.txt", content: "literal </tool>{ hostile text", permission: "allow" },
    ]) {
      expect(codes(validate({ type: "invoke", tool: "write_file", arguments: arguments_ }))).toContain(
        "invalid_arguments",
      )
    }
  })

  test("fails closed on an invalid disclosed tool schema", () => {
    expect(
      codes(
        validate(
          { type: "invoke", tool: "write_file", arguments: intent().knownArguments },
          { shortlist: [{ ...write, inputSchema: { type: "not-a-json-schema-type" } }] },
        ),
      ),
    ).toContain("invalid_tool_schema")
    expect(
      codes(
        validate(
          { type: "invoke", tool: "write_file", arguments: intent().knownArguments },
          { shortlist: [{ ...write, inputSchema: { ...write.inputSchema, $async: true } }] },
        ),
      ),
    ).toContain("invalid_tool_schema")
  })

  test("missing arguments force the exact need_parameters response", () => {
    const missingIntent = intent({ knownArguments: { path: "notes/a.txt" }, missingArguments: ["content"] })
    expect(
      codes(
        validate(
          { type: "invoke", tool: "write_file", arguments: { path: "notes/a.txt", content: "invented" } },
          { intent: missingIntent },
        ),
      ),
    ).toContain("invoke_with_missing_arguments")
    expect(
      ToolRouter.validate({
        intent: missingIntent,
        result: { type: "need_parameters", fields: ["content"] },
        shortlist: [write],
        nowMs: NOW,
      }).ok,
    ).toBe(true)
    expect(
      codes(validate({ type: "need_parameters", fields: ["content", "permission"] }, { intent: missingIntent })),
    ).toContain("parameters_not_missing")
  })

  test("rejects duplicate parameter requests", () => {
    expect(
      codes(
        validate(
          { type: "need_parameters", fields: ["content", "content"] },
          { intent: intent({ knownArguments: { path: "notes/a.txt" }, missingArguments: ["content"] }) },
        ),
      ),
    ).toContain("duplicate_parameter")
  })

  test("rejects contradictory and duplicate missing-argument declarations", () => {
    expect(
      codes(
        validate(
          { type: "need_parameters", fields: ["content"] },
          {
            intent: intent({
              knownArguments: { path: "notes/a.txt", content: "already known" },
              missingArguments: ["content", "content"],
            }),
          },
        ),
      ),
    ).toEqual(expect.arrayContaining(["duplicate_missing_argument", "argument_both_known_and_missing"]))
  })

  test("accepts an explicit abstention", () => {
    expect(validate({ type: "abstain", reason: "the shortlist cannot satisfy the evidence" }).ok).toBe(true)
  })

  test("rejects expired intent and malformed shortlists", () => {
    expect(codes(validate({ type: "abstain", reason: "late" }, { intent: intent({ deadline: NOW }) }))).toContain(
      "deadline_expired",
    )
    expect(codes(validate({ type: "abstain", reason: "none" }, { shortlist: [] }))).toContain("empty_shortlist")
    expect(codes(validate({ type: "abstain", reason: "duplicate" }, { shortlist: [write, write] }))).toContain(
      "duplicate_tool",
    )
    expect(
      codes(
        validate(
          { type: "abstain", reason: "too many" },
          {
            shortlist: Array.from({ length: ToolRouter.MAX_SHORTLIST + 1 }, (_, i) => ({
              ...write,
              name: `tool_${i}`,
            })),
          },
        ),
      ),
    ).toContain("shortlist_too_large")
  })
})
