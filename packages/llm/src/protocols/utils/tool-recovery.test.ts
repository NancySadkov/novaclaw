import { describe, expect, test } from "bun:test"
import { recoverToolCallsFromText, resolveToolName, scrubName } from "./tool-recovery"

const TOOLS = ["read", "bash", "write", "list", "apply_patch"]

describe("resolveToolName", () => {
  test("exact match passes through", () => expect(resolveToolName("read", TOOLS)).toBe("read"))
  test("case-insensitive (Write -> write)", () => expect(resolveToolName("Write", TOOLS)).toBe("write"))
  test("upper-case (READ -> read)", () => expect(resolveToolName("READ", TOOLS)).toBe("read"))
  test("scrubs leaked harmony token (write<|channel|>commentary -> write)", () =>
    expect(resolveToolName("write<|channel|>commentary", TOOLS)).toBe("write"))
  test("fuzzy typo within cutoff (apply_path -> apply_patch)", () =>
    expect(resolveToolName("apply_path", TOOLS)).toBe("apply_patch"))
  test("hallucinated name -> undefined", () => expect(resolveToolName("frobnicate", TOOLS)).toBeUndefined())
  test("near-miss below the 0.85 cutoff -> undefined (reads !-> read)", () =>
    expect(resolveToolName("reads", TOOLS)).toBeUndefined())
  test("scrubName cuts at the first harmony token", () =>
    expect(scrubName("read<|channel|>x")).toBe("read"))
})

describe("recoverToolCallsFromText — hermes / <tool_call>", () => {
  test("closed block with nested arguments", () =>
    expect(recoverToolCallsFromText('<tool_call>{"name":"read","arguments":{"filePath":"a.ts"}}</tool_call>', TOOLS)).toEqual(
      [{ name: "read", arguments: '{"filePath":"a.ts"}' }],
    ))
  test("UNCLOSED block still recovers", () =>
    expect(recoverToolCallsFromText('<tool_call>{"name":"read","arguments":{"filePath":"a.ts"}}', TOOLS)).toEqual([
      { name: "read", arguments: '{"filePath":"a.ts"}' },
    ]))
  test("FLAT args (siblings of name) normalize to nested", () =>
    expect(recoverToolCallsFromText('<tool_call>{"name":"read","filePath":"a.ts"}</tool_call>', TOOLS)).toEqual([
      { name: "read", arguments: '{"filePath":"a.ts"}' },
    ]))
  test("preamble prose before the block is ignored", () =>
    expect(
      recoverToolCallsFromText('Sure, let me look. <tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>', TOOLS),
    ).toEqual([{ name: "bash", arguments: '{"command":"ls"}' }]))
  test("name is canonicalized (Read -> read)", () =>
    expect(recoverToolCallsFromText('<tool_call>{"name":"Read","arguments":{"filePath":"a"}}</tool_call>', TOOLS)).toEqual([
      { name: "read", arguments: '{"filePath":"a"}' },
    ]))
  test("leaked harmony token in the name is scrubbed", () =>
    expect(
      recoverToolCallsFromText('<tool_call>{"name":"write<|channel|>x","arguments":{"path":"a"}}</tool_call>', TOOLS),
    ).toEqual([{ name: "write", arguments: '{"path":"a"}' }]))
  test("multiple blocks recover in order", () =>
    expect(
      recoverToolCallsFromText(
        '<tool_call>{"name":"read","arguments":{"filePath":"a"}}</tool_call><tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
        TOOLS,
      ),
    ).toEqual([
      { name: "read", arguments: '{"filePath":"a"}' },
      { name: "bash", arguments: '{"command":"ls"}' },
    ]))
  test("hermes block naming an UNKNOWN tool is dropped", () =>
    expect(recoverToolCallsFromText('<tool_call>{"name":"frobnicate","arguments":{}}</tool_call>', TOOLS)).toEqual([]))
})

describe("recoverToolCallsFromText — bare JSON", () => {
  test("single object", () =>
    expect(recoverToolCallsFromText('{"name":"read","arguments":{"filePath":"a"}}', TOOLS)).toEqual([
      { name: "read", arguments: '{"filePath":"a"}' },
    ]))
  test("array of calls", () =>
    expect(
      recoverToolCallsFromText('[{"name":"read","arguments":{"filePath":"a"}},{"name":"list","arguments":{"path":"/"}}]', TOOLS),
    ).toEqual([
      { name: "read", arguments: '{"filePath":"a"}' },
      { name: "list", arguments: '{"path":"/"}' },
    ]))
})

describe("recoverToolCallsFromText — XML-ish", () => {
  test("recovers <read><filePath>x</filePath></read>", () =>
    expect(recoverToolCallsFromText("<read><filePath>a.ts</filePath></read>", TOOLS)).toEqual([
      { name: "read", arguments: '{"filePath":"a.ts"}' },
    ]))
  test("outer tag canonicalized (<Read> -> read)", () =>
    expect(recoverToolCallsFromText("<Read><filePath>a.ts</filePath></Read>", TOOLS)).toEqual([
      { name: "read", arguments: '{"filePath":"a.ts"}' },
    ]))
})

// The load-bearing safety cases: ordinary prose / code with angle brackets or
// JSON-shaped data must NEVER be misread as a tool call.
describe("recoverToolCallsFromText — prose-misreading guards", () => {
  test("C++ template angle brackets", () =>
    expect(recoverToolCallsFromText("std::vector<int> v; v.push_back(1);", TOOLS)).toEqual([]))
  test("HTML tags (non-tool names)", () =>
    expect(recoverToolCallsFromText("<p>Hello <b>world</b></p>", TOOLS)).toEqual([]))
  test("a tool name mentioned in prose WITHOUT param pairs", () =>
    expect(recoverToolCallsFromText("Use the <read> tool to load files.", TOOLS)).toEqual([]))
  test("comparison operators in prose", () =>
    expect(recoverToolCallsFromText("if a < b and c > d then act", TOOLS)).toEqual([]))
  test("JSON data that is not a call (name is not a tool)", () =>
    expect(recoverToolCallsFromText('{"name":"Ada Lovelace","born":1815}', TOOLS)).toEqual([]))
  test("plain prose", () => expect(recoverToolCallsFromText("Here is the answer: 42.", TOOLS)).toEqual([]))
  test("empty allowed set never guesses", () =>
    expect(recoverToolCallsFromText('<tool_call>{"name":"read","arguments":{}}</tool_call>', [])).toEqual([]))
  test("empty text", () => expect(recoverToolCallsFromText("", TOOLS)).toEqual([]))
})
