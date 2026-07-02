import { describe, expect, test } from "bun:test"
import { resolveToolName, repairToolArgs } from "./tool-repair"

const tools = ["read", "write", "bash", "edit", "glob", "grep", "webfetch", "todowrite"]

describe("resolveToolName", () => {
  test("exact match", () => expect(resolveToolName("read", tools)).toBe("read"))
  test("case-insensitive (Write -> write)", () => expect(resolveToolName("Write", tools)).toBe("write"))
  test("fuzzy near-miss (webfetc -> webfetch)", () => expect(resolveToolName("webfetc", tools)).toBe("webfetch"))
  test("scrubs harmony token in name", () =>
    expect(resolveToolName("write<|channel|>commentary", tools)).toBe("write"))
  test("hallucinated returns undefined", () => expect(resolveToolName("teleport", tools)).toBeUndefined())
})

describe("repairToolArgs", () => {
  test("passes valid json through", () => expect(repairToolArgs('{"a":1}')).toBe('{"a":1}'))
  test("recovers from preamble + trailing tool-call tag", () =>
    expect(repairToolArgs('here you go: {"filePath":"x"} </tool_call>')).toBe('{"filePath":"x"}'))
  test("strips harmony tokens", () => expect(repairToolArgs('<|channel|>{"q":"hi"}<|end|>')).toBe('{"q":"hi"}'))
  test("empty -> {}", () => expect(repairToolArgs("")).toBe("{}"))
  test("unrecoverable -> undefined", () => expect(repairToolArgs("not json at all")).toBeUndefined())
  test("non-string object -> serialized", () => expect(repairToolArgs({ a: 1 })).toBe('{"a":1}'))
})
