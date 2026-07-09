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
