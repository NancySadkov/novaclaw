import { describe, expect, test } from "bun:test"
import { isTruncatedToolArgs, repairToolJson } from "./shared"
import { truncatedArgsInput, truncatedArgsMessage, truncatedArgsResult } from "./utils/truncated-args"

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

describe("isTruncatedToolArgs (1O/A4)", () => {
  test("a substantial started-but-unclosed object is truncated", () => {
    expect(isTruncatedToolArgs('{"path":"out.txt","content":"aaaaaaaa')).toBe(true)
    expect(isTruncatedToolArgs('{"path":"a","content":"zzz')).toBe(true)
  })

  test("a genuine zero-arg call ('' / '{}' / whitespace) is NOT truncated", () => {
    expect(isTruncatedToolArgs("")).toBe(false)
    expect(isTruncatedToolArgs("{}")).toBe(false)
    expect(isTruncatedToolArgs("   ")).toBe(false)
  })

  test("a complete object is NOT truncated", () => {
    expect(isTruncatedToolArgs('{"path":"a.ts","content":"ok"}')).toBe(false)
  })

  test("recoverable preamble/trailing junk is NOT truncated (repair salvages it)", () => {
    expect(isTruncatedToolArgs('{"filePath":"x.c"} </tool_call>')).toBe(false)
  })

  test("prose that doesn't start a JSON container is NOT truncated", () => {
    expect(isTruncatedToolArgs("I will now write the file")).toBe(false)
  })
})

describe("truncated-args sentinel round-trip (1O/A4)", () => {
  test("input carries the parse error and reads back out", () => {
    const input = truncatedArgsInput("unexpected end of JSON input")
    expect(truncatedArgsMessage(input)).toBe("unexpected end of JSON input")
  })

  test("a normal args object is not mistaken for the sentinel", () => {
    expect(truncatedArgsMessage({ path: "a", content: "b" })).toBeUndefined()
    expect(truncatedArgsMessage(null)).toBeUndefined()
    expect(truncatedArgsMessage("string")).toBeUndefined()
  })

  test("the prescriptive result names the real cause and the chunked-heredoc fix", () => {
    const result = truncatedArgsResult("write", "unexpected end of JSON input")
    expect(result).toContain("`write`")
    expect(result.toLowerCase()).toContain("truncated")
    expect(result).toContain("cat >")
    expect(result.toLowerCase()).toContain("do not retry")
  })
})
