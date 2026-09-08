/**
 * JSON Schema validation, owned. Replaces `ajv` (2026-09-03, AGENTS.md principle 2) for its one
 * consumer, `tool-router.ts`, which validated a model's proposed tool arguments against the tool's
 * `inputSchema` and read back one boolean and a list of `instancePath:keyword` failures.
 *
 * 🔴 Why own it. Ajv compiles every schema to JavaScript through `new Function` at runtime, on the
 * one path in this process that consumes MODEL output — the same posture that closed the `js`
 * tool's vm escape. What we used of it was the subset below; `$ref` resolution to external
 * documents and format validation were already switched off (`validateFormats: false`,
 * `strict: false`).
 *
 * The dialect, held to a recording of ajv@8.20.0's answers by `test/json-schema-validate.test.ts`:
 * - `type` (a name or a list; `integer` is a whole number; `number` is any JS number), `enum`, `const`;
 * - objects: `properties`, `required`, `additionalProperties` (boolean or schema),
 *   `patternProperties`, `propertyNames`, `minProperties`, `maxProperties`;
 * - arrays: `items` (a schema, or the draft-7 tuple form), `prefixItems`, `additionalItems`,
 *   `minItems`, `maxItems`, `uniqueItems`;
 * - numbers: `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`;
 * - strings: `minLength`, `maxLength` (in code points), `pattern` (unanchored, as ajv);
 * - combinators: `allOf`, `anyOf`, `oneOf`, `not`; `nullable: true` admits `null`;
 * - `$ref` to a JSON pointer inside the SAME document (`#/$defs/x`, `#/definitions/x`, `#`);
 * - every other keyword is ignored, which is what `strict: false` did.
 * A schema that is not a schema (`type: "banana"`, `required: "a"`) THROWS at compile, as ajv did;
 * the router turns that into `invalid_tool_schema`.
 *
 * Errors follow ajv's `allErrors` shape as far as the router can see them: every failing keyword at
 * every path, with `anyOf`/`oneOf` reporting their branches' failures and then their own.
 */
export * as JsonSchemaValidate from "./json-schema-validate"

export interface Failure {
  readonly instancePath: string
  readonly keyword: string
}

export interface Result {
  readonly ok: boolean
  readonly errors: ReadonlyArray<Failure>
}

export class InvalidSchemaError extends Error {
  override readonly name = "InvalidSchemaError"
}

type SchemaObject = Record<string, unknown>
type Schema = SchemaObject | boolean

const TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"])

/** Validate `value` against `schema`. Throws `InvalidSchemaError` for a schema that is not one. */
export function validate(schema: unknown, value: unknown): Result {
  const root = checkSchema(schema, "")
  const errors: Failure[] = []
  const ok = run(root, root, value, "", errors)
  return { ok, errors }
}

// ─── schema checks, once per validate (ajv checked at compile) ───────────────────────────────────

function checkSchema(schema: unknown, at: string): Schema {
  if (typeof schema === "boolean") return schema
  if (typeof schema !== "object" || schema === null || Array.isArray(schema))
    throw new InvalidSchemaError(`schema${at || " root"} must be an object or a boolean`)
  const s = schema as SchemaObject
  if ("type" in s) {
    const names = Array.isArray(s.type) ? s.type : [s.type]
    for (const name of names)
      if (typeof name !== "string" || !TYPES.has(name))
        throw new InvalidSchemaError(`schema${at}/type: unknown type ${JSON.stringify(name)}`)
  }
  if ("required" in s && (!Array.isArray(s.required) || s.required.some((r) => typeof r !== "string")))
    throw new InvalidSchemaError(`schema${at}/required must be an array of strings`)
  for (const key of ["properties", "patternProperties", "$defs", "definitions"] as const) {
    const map = s[key]
    if (map === undefined) continue
    if (typeof map !== "object" || map === null || Array.isArray(map))
      throw new InvalidSchemaError(`schema${at}/${key} must be an object`)
    for (const [name, sub] of Object.entries(map as SchemaObject)) checkSchema(sub, `${at}/${key}/${name}`)
  }
  for (const key of ["items", "additionalProperties", "additionalItems", "propertyNames", "not"] as const) {
    if (s[key] === undefined) continue
    if (key === "items" && Array.isArray(s.items)) s.items.forEach((sub, i) => checkSchema(sub, `${at}/items/${i}`))
    else checkSchema(s[key], `${at}/${key}`)
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"] as const) {
    const list = s[key]
    if (list === undefined) continue
    if (!Array.isArray(list)) throw new InvalidSchemaError(`schema${at}/${key} must be an array`)
    list.forEach((sub, i) => checkSchema(sub, `${at}/${key}/${i}`))
  }
  return s
}

// ─── evaluation ──────────────────────────────────────────────────────────────────────────────────

function run(root: Schema, schema: Schema, value: unknown, path: string, errors: Failure[]): boolean {
  if (schema === true) return true
  if (schema === false) {
    errors.push({ instancePath: path, keyword: "false schema" })
    return false
  }
  let ok = true
  const fail = (keyword: string) => {
    errors.push({ instancePath: path, keyword })
    ok = false
  }

  if (typeof schema.$ref === "string") {
    const target = resolveRef(root, schema.$ref)
    if (!run(root, target, value, path, errors)) ok = false
  }

  if (schema.nullable === true && value === null) return ok

  if ("type" in schema) {
    const names = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[]
    if (!names.some((name) => isType(name, value))) fail("type")
  }
  if ("enum" in schema && Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, value)))
    fail("enum")
  if ("const" in schema && !deepEqual(schema.const, value)) fail("const")

  if (typeof value === "number") {
    const n = value
    if (typeof schema.minimum === "number" && n < schema.minimum) fail("minimum")
    if (typeof schema.maximum === "number" && n > schema.maximum) fail("maximum")
    if (typeof schema.exclusiveMinimum === "number" && n <= schema.exclusiveMinimum) fail("exclusiveMinimum")
    if (typeof schema.exclusiveMaximum === "number" && n >= schema.exclusiveMaximum) fail("exclusiveMaximum")
    if (typeof schema.multipleOf === "number" && !isMultiple(n, schema.multipleOf)) fail("multipleOf")
  }

  if (typeof value === "string") {
    const length = [...value].length
    if (typeof schema.minLength === "number" && length < schema.minLength) fail("minLength")
    if (typeof schema.maxLength === "number" && length > schema.maxLength) fail("maxLength")
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) fail("pattern")
  }

  if (Array.isArray(value)) {
    const items = value
    if (typeof schema.minItems === "number" && items.length < schema.minItems) fail("minItems")
    if (typeof schema.maxItems === "number" && items.length > schema.maxItems) fail("maxItems")
    if (schema.uniqueItems === true && items.some((a, i) => items.slice(0, i).some((b) => deepEqual(a, b))))
      fail("uniqueItems")
    const tuple = Array.isArray(schema.prefixItems)
      ? (schema.prefixItems as Schema[])
      : Array.isArray(schema.items)
        ? (schema.items as Schema[])
        : undefined
    if (tuple !== undefined) {
      tuple.forEach((sub, i) => {
        if (i < items.length && !run(root, sub, items[i], `${path}/${i}`, errors)) ok = false
      })
      const rest = Array.isArray(schema.prefixItems) ? schema.items : schema.additionalItems
      if (rest === false && items.length > tuple.length)
        fail(Array.isArray(schema.prefixItems) ? "items" : "additionalItems")
      else if (rest !== undefined && rest !== true && typeof rest === "object")
        items.slice(tuple.length).forEach((item, i) => {
          if (!run(root, rest as Schema, item, `${path}/${tuple.length + i}`, errors)) ok = false
        })
    } else if (schema.items !== undefined && schema.items !== true) {
      if (schema.items === false) {
        if (items.length > 0) fail("items")
      } else
        items.forEach((item, i) => {
          if (!run(root, schema.items as Schema, item, `${path}/${i}`, errors)) ok = false
        })
    }
  }

  if (isObject(value)) {
    const object = value as Record<string, unknown>
    const keys = Object.keys(object)
    if (Array.isArray(schema.required)) {
      for (const name of schema.required as string[]) if (!(name in object)) fail("required")
    }
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) fail("minProperties")
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) fail("maxProperties")
    const properties = (schema.properties ?? {}) as Record<string, Schema>
    const patterns = Object.entries((schema.patternProperties ?? {}) as Record<string, Schema>).map(
      ([source, sub]) => [new RegExp(source, "u"), sub] as const,
    )
    for (const key of keys) {
      const child = `${path}/${escapePointer(key)}`
      let covered = false
      if (key in properties) {
        covered = true
        if (!run(root, properties[key]!, object[key], child, errors)) ok = false
      }
      for (const [regex, sub] of patterns) {
        if (!regex.test(key)) continue
        covered = true
        if (!run(root, sub, object[key], child, errors)) ok = false
      }
      if (!covered && schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        if (schema.additionalProperties === false) fail("additionalProperties")
        else if (!run(root, schema.additionalProperties as Schema, object[key], child, errors)) ok = false
      }
      // A bad property NAME is reported at the object's own path, as ajv does: the name is not an
      // instance location the caller could point at.
      if (schema.propertyNames !== undefined && !run(root, schema.propertyNames as Schema, key, path, errors))
        fail("propertyNames")
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf as Schema[]) if (!run(root, sub, value, path, errors)) ok = false
  }
  if (Array.isArray(schema.anyOf)) {
    const branch: Failure[] = []
    const passed = (schema.anyOf as Schema[]).some((sub) => run(root, sub, value, path, branch))
    if (!passed) {
      errors.push(...branch)
      fail("anyOf")
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const branch: Failure[] = []
    let passed = 0
    for (const sub of schema.oneOf as Schema[]) if (run(root, sub, value, path, branch)) passed++
    if (passed !== 1) {
      if (passed === 0) errors.push(...branch)
      fail("oneOf")
    }
  }
  if (schema.not !== undefined) {
    const scratch: Failure[] = []
    if (run(root, schema.not as Schema, value, path, scratch)) fail("not")
  }
  return ok
}

function isType(name: string, value: unknown): boolean {
  switch (name) {
    case "null":
      return value === null
    case "boolean":
      return typeof value === "boolean"
    case "string":
      return typeof value === "string"
    case "number":
      // Any JS number, `NaN` included — ajv's `type: "number"` is `typeof === "number"`, and the
      // router's arguments arrive as JSON, where `NaN` cannot occur anyway.
      return typeof value === "number"
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "array":
      return Array.isArray(value)
    case "object":
      return isObject(value)
    default:
      return false
  }
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMultiple(n: number, by: number): boolean {
  const q = n / by
  return Number.isFinite(q) && Math.abs(q - Math.round(q)) < 1e-9
}

function resolveRef(root: Schema, ref: string): Schema {
  if (!ref.startsWith("#")) throw new InvalidSchemaError(`$ref ${JSON.stringify(ref)} points outside the document`)
  if (ref === "#" || ref === "#/") return root
  let node: unknown = root
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~")
    if (typeof node !== "object" || node === null || !(key in (node as object)))
      throw new InvalidSchemaError(`$ref ${JSON.stringify(ref)} cannot be resolved`)
    node = (node as Record<string, unknown>)[key]
  }
  return checkSchema(node, ref)
}

function escapePointer(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1")
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a))
    return a.length === (b as unknown[]).length && a.every((item, i) => deepEqual(item, (b as unknown[])[i]))
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length && keys.every((key) => key in right && deepEqual(left[key], right[key]))
  )
}
