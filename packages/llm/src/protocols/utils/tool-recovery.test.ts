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
  test("doubled identical calls are deduped to one (1A.e)", () =>
    expect(
      recoverToolCallsFromText(
        '<tool_call>{"name":"read","arguments":{"filePath":"a"}}</tool_call><tool_call>{"name":"read","arguments":{"filePath":"a"}}</tool_call>',
        TOOLS,
      ),
    ).toEqual([{ name: "read", arguments: '{"filePath":"a"}' }]))
  test("same tool with DIFFERENT args are both kept", () =>
    expect(
      recoverToolCallsFromText(
        '<tool_call>{"name":"read","arguments":{"filePath":"a"}}</tool_call><tool_call>{"name":"read","arguments":{"filePath":"b"}}</tool_call>',
        TOOLS,
      ),
    ).toEqual([
      { name: "read", arguments: '{"filePath":"a"}' },
      { name: "read", arguments: '{"filePath":"b"}' },
    ]))
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

// qwen3_coder malformed variants — observed LIVE 2026-07-21 (issues.md mask-token P2): the
// model's structured emission derails and the server-side parser passes raw text through.
describe("recoverToolCallsFromText — qwen3_coder shapes", () => {
  test("bare tool tag with <parameter=name> children (the live CLI emission)", () =>
    expect(
      recoverToolCallsFromText(
        "<write>\n<parameter=path>\nmask-probe.txt\n</parameter>\n<parameter=content>\nhello\n</parameter>\n</write>",
        TOOLS,
      ),
    ).toEqual([{ name: "write", arguments: '{"path":"mask-probe.txt","content":"hello"}' }]))
  test("<function=name> opener without the <tool_call> wrapper", () =>
    expect(
      recoverToolCallsFromText("<function=write><parameter=path>a.txt</parameter></function>", TOOLS),
    ).toEqual([{ name: "write", arguments: '{"path":"a.txt"}' }]))
  test("unclosed trailing <parameter=…> still recovers (stream cut mid-call)", () =>
    expect(recoverToolCallsFromText("<write><parameter=path>a.txt", TOOLS)).toEqual([
      { name: "write", arguments: '{"path":"a.txt"}' },
    ]))
  test("special-token-fused tags recover (<|bash><|command>… — the live no-recall emission)", () =>
    expect(
      recoverToolCallsFromText("<|bash>\n<|command>\necho hello > f.txt\n</|command>\n</bash>", TOOLS),
    ).toEqual([{ name: "bash", arguments: '{"command":"echo hello > f.txt"}' }]))
  test("tool_-prefixed name + mismatched close tags recover (the live <tool_write> emission)", () =>
    expect(
      recoverToolCallsFromText(
        "<tool_write>\n<file_path>\nC:\\x\\final-probe.txt\n</file_content>\nhello\n</tool_write>",
        TOOLS,
      ),
    ).toEqual([{ name: "write", arguments: '{"file_path":"C:\\\\x\\\\final-probe.txt"}' }]))
  test("tool_ prefix never invents a call for a non-tool remainder", () =>
    expect(recoverToolCallsFromText("<tool_frobnicate><x>1</x></tool_frobnicate>", TOOLS)).toEqual([]))
})

describe("recoverToolCallsFromText — mask-token wrapping + paren-call syntax", () => {
  test("MTP mask tokens around a paren call (the live GUI emission)", () =>
    expect(
      recoverToolCallsFromText('\n\n<|mask_start|> write(path="perm-test.txt", content="hello")<|mask_end|>', TOOLS),
    ).toEqual([{ name: "write", arguments: '{"path":"perm-test.txt","content":"hello"}' }]))
  test("paren call with single quotes and escapes", () =>
    expect(recoverToolCallsFromText("read(filePath='a \\'b\\'.ts')", TOOLS)).toEqual([
      { name: "read", arguments: '{"filePath":"a \'b\'.ts"}' },
    ]))
  test("mask tokens around an XML call still recover", () =>
    expect(
      recoverToolCallsFromText("<|mask_start|><write><parameter=path>x</parameter></write><|mask_end|>", TOOLS),
    ).toEqual([{ name: "write", arguments: '{"path":"x"}' }]))
  test("pure mask-token garbage recovers nothing", () =>
    expect(recoverToolCallsFromText("\n\n<|mask_start|><think>\n\n\n\n<|mask_start|><think>\n\n\n\n<|mask_end|>", TOOLS)).toEqual(
      [],
    ))
  test("prose naming a tool with UNQUOTED parens never matches", () =>
    expect(recoverToolCallsFromText("You can call write(path, content) to save files.", TOOLS)).toEqual([]))
  test("prose with a quoted pair plus extra words never matches", () =>
    expect(recoverToolCallsFromText('call write(path="a.txt" and more things) please', TOOLS)).toEqual([]))
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
