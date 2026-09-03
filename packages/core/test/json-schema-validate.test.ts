import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { JsonSchemaValidate } from "@novaclaw/core/util/json-schema-validate"
import { CASES } from "./json-schema-conformance-corpus"
import type { Recorded } from "./json-schema-conformance-record"

/**
 * The owned validator against the answers `ajv@8.20.0` gave on the day it was replaced, under the
 * options `tool-router.ts` used (`json-schema-conformance-record.ts` wrote the recording). One test
 * per pair, on BOTH halves the router reads: the verdict, and the sorted set of
 * `instancePath:keyword` failures that becomes `invalid_arguments.detail`.
 */
const expected = JSON.parse(
  readFileSync(join(import.meta.dir, "json-schema-conformance-expected.json"), "utf8"),
) as Recorded[]

const answer = (schema: unknown, value: unknown): Recorded => {
  try {
    const result = JsonSchemaValidate.validate(schema, value)
    const errors = [...new Set(result.errors.map((e) => `${e.instancePath || "/"}:${e.keyword}`))].sort()
    return { ok: result.ok, errors }
  } catch (error) {
    return { ok: false, errors: [], threw: error instanceof Error ? error.message : String(error) }
  }
}

describe("JsonSchemaValidate answers what ajv answered", () => {
  test("the recording covers the corpus", () => {
    expect(expected.length).toBe(CASES.length)
  })
  CASES.forEach((c, index) => {
    const want = expected[index]!
    test(`${c.name} → ${want.threw ? "throws" : want.ok ? "ok" : want.errors.join(" ")}`, () => {
      const got = answer(c.schema, c.value)
      if (want.threw !== undefined) {
        expect(got.threw, "ajv refused this schema at compile; so must we").toBeDefined()
        return
      }
      expect(got.threw).toBeUndefined()
      expect(got.ok).toBe(want.ok)
      expect(got.errors).toEqual(want.errors)
    })
  })
})

describe("what the router relies on beyond the recording", () => {
  test("a recursive $ref does not recurse forever on a deep value", () => {
    const schema = { $defs: { n: { type: "object", properties: { c: { $ref: "#/$defs/n" } } } }, $ref: "#/$defs/n" }
    let value: unknown = {}
    for (let i = 0; i < 200; i++) value = { c: value }
    expect(JsonSchemaValidate.validate(schema, value).ok).toBe(true)
  })
  test("a $ref outside the document is refused, never fetched", () => {
    expect(() => JsonSchemaValidate.validate({ $ref: "https://example.com/x.json" }, {})).toThrow(
      JsonSchemaValidate.InvalidSchemaError,
    )
  })
  test("NEGATIVE CONTROL: the corpus can disagree", () => {
    expect(JsonSchemaValidate.validate({ type: "integer" }, 1.5).ok).toBe(false)
    expect(JsonSchemaValidate.validate({ type: "integer" }, 2).ok).toBe(true)
  })
})
