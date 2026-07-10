import { describe, expect, test } from "bun:test"
import { JhExtract } from "./extract"

const value = (r: JhExtract.ExtractResult): any => {
  if (!r.ok) throw new Error(`expected ok, got ${r.failure.reason}: ${r.failure.detail}`)
  return r.value
}

describe("extractJsonObject", () => {
  test("bare JSON object alone", () => {
    const r = JhExtract.extractJsonObject('{"a": 1, "b": "two"}')
    expect(value(r)).toEqual({ a: 1, b: "two" })
  })

  test("fenced ```json block with prose before and after", () => {
    const text = 'Sure, here is my step:\n```json\n{"goal": "x", "size": "atomic"}\n```\nDone.'
    expect(value(JhExtract.extractJsonObject(text))).toEqual({ goal: "x", size: "atomic" })
  })

  test("TWO fenced blocks — the LAST wins", () => {
    const text = '```json\n{"which": "first"}\n```\nprose between\n```json\n{"which": "last"}\n```'
    expect(value(JhExtract.extractJsonObject(text)).which).toBe("last")
  })

  test("unfenced object embedded mid-prose", () => {
    const text = 'I think the answer is {"choice": "machin"} and that is final.'
    expect(value(JhExtract.extractJsonObject(text))).toEqual({ choice: "machin" })
  })

  test("braces inside string values and escaped quotes don't break the scanner", () => {
    const text = '{"goal": "write {main} and }close{", "q": "he said \\"hi\\" ok"}'
    expect(value(JhExtract.extractJsonObject(text))).toEqual({ goal: "write {main} and }close{", q: 'he said "hi" ok' })
  })

  test("trailing comma healed", () => {
    expect(value(JhExtract.extractJsonObject('{"a": 1, "b": [2, 3,],}'))).toEqual({ a: 1, b: [2, 3] })
  })

  test("unbalanced object → unbalanced", () => {
    const r = JhExtract.extractJsonObject('here it is: {"a": {')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.reason).toBe("unbalanced")
  })

  test("no JSON at all → no_json", () => {
    const r = JhExtract.extractJsonObject("just prose, no object, nothing to see here")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.reason).toBe("no_json")
  })

  test("invalid backslash escapes healed — stray backslashes (§12 file-write wall)", () => {
    // \o \z \q are all invalid JSON escapes → doubled to literal backslashes. (A path with \b/\t/\n
    // is genuinely ambiguous — those are VALID escapes — which is why the harness steers paths to
    // forward slashes; the repair only rescues unambiguous invalid escapes.)
    const r = JhExtract.extractJsonObject('{"cmd": "type C:\\opt\\zz\\qq"}')
    expect(value(r).cmd).toBe("type C:\\opt\\zz\\qq")
  })

  test("invalid C escapes healed but valid escapes preserved", () => {
    const r = JhExtract.extractJsonObject('{"content": "char z = \'\\0\'; printf(\\"hi\\\\n\\");\\n\\ttab"}')
    // \0 (invalid) becomes literal backslash-zero; \\n and \n and \t (valid) are preserved
    expect(value(r).content).toBe('char z = \'\\0\'; printf("hi\\n");\n\ttab')
  })

  test("already-correct escaped backslashes are NOT corrupted", () => {
    const r = JhExtract.extractJsonObject('{"path": "C:\\\\already\\\\escaped"}')
    expect(value(r).path).toBe("C:\\already\\escaped")
  })

  test("balanced but invalid JSON (single quotes) → invalid_json, NOT healed", () => {
    const r = JhExtract.extractJsonObject("{'a': 1}")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure.reason).toBe("invalid_json")
  })

  test("100 KB of prose with the object at the end parses fast", () => {
    const text = "lorem ipsum ".repeat(9000) + '\nfinal answer:\n{"done": true, "n": 42}'
    const started = performance.now()
    const r = JhExtract.extractJsonObject(text)
    const elapsed = performance.now() - started
    expect(value(r)).toEqual({ done: true, n: 42 })
    expect(elapsed).toBeLessThan(1000)
  })
})

describe("extractJsonObject located syntax hints (improve3 P2b)", () => {
  const fail = (text: string) => {
    const r = JhExtract.extractJsonObject(text)
    if (r.ok) throw new Error("expected a failure")
    return r.failure
  }

  test("invalid_json carries a likely-cause hint + a bounded snippet", () => {
    const f = fail('```json\n{"goal": "x", "size": "atomic" oops}\n```')
    expect(f.reason).toBe("invalid_json")
    expect(f.cause).toBeTruthy()
    expect(f.snippet).toContain("goal")
    expect((f.snippet ?? "").length).toBeLessThanOrEqual(200)
  })

  test("unbalanced (truncated) carries a position + snippet + a truncation hint", () => {
    const f = fail('{"goal": "write the whole plan", "substeps": [{"goal": "a"')
    expect(f.reason).toBe("unbalanced")
    expect(typeof f.position).toBe("number")
    expect(f.cause).toContain("TRUNCATED")
    expect(f.snippet).toBeTruthy()
  })

  test("no_json carries an actionable cause", () => {
    const f = fail("I will now think about the plan but never emit an object.")
    expect(f.reason).toBe("no_json")
    expect(f.cause).toContain("json")
  })

  test("a 20k-char reply's snippet stays bounded (no huge echo)", () => {
    const huge = '{"goal": "' + "x".repeat(20000) + '" oops}'
    const f = fail(huge)
    expect((f.snippet ?? "").length).toBeLessThanOrEqual(200)
  })

  test("a valid object still parses (happy path unchanged)", () => {
    const r = JhExtract.extractJsonObject('{"goal": "x", "size": "atomic"}')
    expect(r.ok).toBe(true)
  })
})
