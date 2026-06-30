import { describe, expect, test } from "bun:test"
import { repairToolJson } from "./shared"

describe("repairToolJson", () => {
  test("valid JSON is returned untouched", () => expect(repairToolJson('{"a":1}')).toBe('{"a":1}'))

  test("valid JSON containing <| inside a string is NOT corrupted", () =>
    expect(repairToolJson('{"text":"use <|special|> token"}')).toBe('{"text":"use <|special|> token"}'))

  test("empty input -> {}", () => {
    expect(repairToolJson("")).toBe("{}")
    expect(repairToolJson("   ")).toBe("{}")
  })

  test("strips leaked harmony tokens around the object", () =>
    expect(JSON.parse(repairToolJson('<|channel|>{"q":"hi"}<|end|>'))).toEqual({ q: "hi" }))

  test("recovers the object span from preamble + trailing tool_call tag", () =>
    expect(JSON.parse(repairToolJson('sure thing: {"filePath":"x.c"} </tool_call>'))).toEqual({ filePath: "x.c" }))

  test("valid array passes through", () => expect(repairToolJson("[1,2]")).toBe("[1,2]"))

  test("unrecoverable input falls back to {} (never throws / never empty)", () =>
    expect(repairToolJson("not json at all")).toBe("{}"))
})
