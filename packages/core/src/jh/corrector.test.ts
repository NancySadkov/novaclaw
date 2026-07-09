import { describe, expect, test } from "bun:test"
import { JhCorrector } from "./corrector"

describe("correctorPrompt", () => {
  const p = JhCorrector.correctorPrompt({
    goal: "write a valid C add()",
    artifactID: "add.c",
    artifactContent: "int add(int a,int b){return a+b}", // missing semicolon
    error: "add.c:1: error: expected ';' before '}'",
  })

  test("contains artifact content and error verbatim", () => {
    expect(p.user).toContain("int add(int a,int b){return a+b}")
    expect(p.user).toContain("add.c:1: error: expected ';'")
  })

  test("never leaks the failure transcript (no transcript/history/prior-attempt language)", () => {
    const all = p.system + "\n" + p.user
    expect(all.toLowerCase()).not.toContain("transcript")
    expect(all.toLowerCase()).not.toContain("history")
    expect(all.toLowerCase()).not.toContain("prior attempt")
  })
})

describe("parseCorrection", () => {
  test("takes the LAST fenced block (any language tag)", () => {
    const text = "first try:\n```c\nOLD\n```\nno, this:\n```c\nint add(int a,int b){return a+b;}\n```"
    const r = JhCorrector.parseCorrection(text)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.content).toBe("int add(int a,int b){return a+b;}")
  })

  test("bare fence (no language tag) works", () => {
    const r = JhCorrector.parseCorrection("```\nhello world\n```")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.content).toBe("hello world")
  })

  test("preserves multi-line content and inner braces", () => {
    const r = JhCorrector.parseCorrection("```c\nint main(){\n  return 0;\n}\n```")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.content).toBe("int main(){\n  return 0;\n}")
  })

  test("no fence → issue", () => {
    const r = JhCorrector.parseCorrection("just prose, no code block")
    expect(r.ok).toBe(false)
  })
})
