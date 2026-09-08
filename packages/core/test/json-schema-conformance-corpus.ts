/**
 * The corpus `json-schema-validate.test.ts` is checked against.
 *
 * ⚠️ `json-schema-conformance-expected.json` was RECORDED from `ajv@8.20.0` on 2026-09-03, the day
 * the dependency was replaced by `core/src/util/json-schema-validate.ts`, with
 * `bun test/json-schema-conformance-record.ts`, under the exact options `tool-router.ts` used:
 * `{ allErrors: true, allowUnionTypes: true, strict: false, validateFormats: false }`. So
 * "equivalent" means: for every (schema, value) pair below, the owned validator answers the verdict
 * ajv answered, and names the same `instancePath:keyword` failures.
 *
 * The shapes: what `Schema.toJsonSchemaDocument` emits for the input schemas the shipped tools
 * declare (measured 2026-09-03: `anyOf` with a `null` arm for `optional`, `enum` for literals,
 * `integer`, `exclusiveMinimum` under `allOf`, nested tagged unions, `additionalProperties: false`,
 * a bare `{type: "object"}` for a record), what an MCP server's foreign schema may carry (`$ref` into
 * `$defs`/`definitions`, `oneOf`, formats that are switched off, `nullable`, `patternProperties`,
 * `minLength`/`pattern`, tuple `items`), the router test's own `write_file` schema, and the hostile
 * values a model produces: `null`, arrays where objects go, numeric strings, extra properties at
 * every depth, `NaN`. Plus two schemas that are not schemas, which must THROW rather than answer.
 */
export interface Case {
  readonly name: string
  readonly schema: unknown
  readonly value: unknown
  /** The pair is expected to throw at compile (an invalid schema); the verdict is the message's presence. */
  readonly throws?: true
}

const writeFile = {
  type: "object",
  properties: { path: { type: "string" }, content: { type: "string" } },
  required: ["path", "content"],
  additionalProperties: false,
}

const optionalNumber = {
  anyOf: [
    {
      anyOf: [
        { type: "number" },
        { type: "string", enum: ["NaN"] },
        { type: "string", enum: ["Infinity"] },
        { type: "string", enum: ["-Infinity"] },
      ],
    },
    { type: "null" },
  ],
}

const effectStruct = {
  type: "object",
  properties: { path: { type: "string" }, limit: optionalNumber, on: { type: "boolean" } },
  required: ["path", "on"],
  additionalProperties: false,
}

const effectNumbers = {
  type: "object",
  properties: {
    n: { type: "number" },
    i: { type: "integer" },
    g: {
      anyOf: [
        { type: "number" },
        { type: "string", enum: ["NaN"] },
        { type: "string", enum: ["Infinity"] },
        { type: "string", enum: ["-Infinity"] },
      ],
      allOf: [{ exclusiveMinimum: 0 }],
    },
  },
  required: ["n", "i", "g"],
  additionalProperties: false,
}

const effectUnion = {
  anyOf: [
    {
      type: "object",
      properties: { kind: { type: "string", enum: ["a"] }, x: { type: "string" } },
      required: ["kind", "x"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { type: "string", enum: ["b"] } },
      required: ["kind"],
      additionalProperties: false,
    },
  ],
}

const effectArray = {
  type: "object",
  properties: { files: { type: "array", items: { type: "string" } } },
  required: ["files"],
  additionalProperties: false,
}

const withDefs = {
  type: "object",
  properties: { node: { $ref: "#/$defs/node" } },
  required: ["node"],
  $defs: {
    node: {
      type: "object",
      properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#/$defs/node" } } },
      required: ["name"],
      additionalProperties: false,
    },
  },
}

const withDefinitions = {
  type: "object",
  properties: { id: { $ref: "#/definitions/id" } },
  definitions: { id: { type: "string", minLength: 3, pattern: "^[a-z]+$" } },
}

const mcpLike = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: 20 },
    count: { type: "integer", minimum: 1, maximum: 10 },
    email: { type: "string", format: "email" },
    when: { type: ["string", "null"] },
    tag: { type: "string", nullable: true },
    mode: { oneOf: [{ const: "fast" }, { const: "slow" }] },
    ratio: { type: "number", multipleOf: 0.5 },
    tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3, uniqueItems: true },
    pair: { type: "array", items: [{ type: "string" }, { type: "number" }], minItems: 2, additionalItems: false },
    meta: { type: "object", patternProperties: { "^x-": { type: "string" } }, additionalProperties: false },
    not: { not: { type: "string" } },
    props: { type: "object", minProperties: 1, maxProperties: 2, propertyNames: { pattern: "^[a-z]+$" } },
  },
  required: ["query"],
}

const okMcp = {
  query: "cats",
  count: 3,
  email: "not-an-email",
  when: null,
  tag: null,
  mode: "fast",
  ratio: 1.5,
  tags: ["a"],
  pair: ["x", 1],
  meta: { "x-a": "1" },
  not: 5,
  props: { a: 1 },
}

export const CASES: ReadonlyArray<Case> = [
  // the router test's own schema, and the model's usual mistakes
  { name: "write_file ok", schema: writeFile, value: { path: "a.txt", content: "x" } },
  { name: "write_file missing content", schema: writeFile, value: { path: "a.txt" } },
  { name: "write_file wrong type", schema: writeFile, value: { path: 42, content: "x" } },
  { name: "write_file extra prop", schema: writeFile, value: { path: "a", content: "x", permission: "allow" } },
  { name: "write_file both wrong", schema: writeFile, value: { path: 42, content: null, extra: 1 } },
  { name: "write_file null", schema: writeFile, value: null },
  { name: "write_file array", schema: writeFile, value: [] },
  { name: "write_file string", schema: writeFile, value: "path" },
  { name: "write_file numeric string for string", schema: writeFile, value: { path: "1", content: "2" } },
  // what effect emits for the shipped tools
  { name: "effect struct ok", schema: effectStruct, value: { path: "p", on: true } },
  { name: "effect struct optional number", schema: effectStruct, value: { path: "p", on: true, limit: 3 } },
  { name: "effect struct optional null", schema: effectStruct, value: { path: "p", on: true, limit: null } },
  {
    name: "effect struct optional Infinity string",
    schema: effectStruct,
    value: { path: "p", on: true, limit: "Infinity" },
  },
  { name: "effect struct optional bad string", schema: effectStruct, value: { path: "p", on: true, limit: "3" } },
  { name: "effect struct missing on", schema: effectStruct, value: { path: "p" } },
  { name: "effect struct boolean as string", schema: effectStruct, value: { path: "p", on: "true" } },
  { name: "effect numbers ok", schema: effectNumbers, value: { n: 1.5, i: 2, g: 0.1 } },
  { name: "effect numbers integer float", schema: effectNumbers, value: { n: 1, i: 2.5, g: 1 } },
  { name: "effect numbers exclusive min", schema: effectNumbers, value: { n: 1, i: 2, g: 0 } },
  { name: "effect numbers NaN arm", schema: effectNumbers, value: { n: 1, i: 2, g: "NaN" } },
  { name: "effect numbers string n", schema: effectNumbers, value: { n: "1", i: 2, g: 1 } },
  { name: "effect union a", schema: effectUnion, value: { kind: "a", x: "1" } },
  { name: "effect union b", schema: effectUnion, value: { kind: "b" } },
  { name: "effect union a missing x", schema: effectUnion, value: { kind: "a" } },
  { name: "effect union unknown kind", schema: effectUnion, value: { kind: "c" } },
  { name: "effect union b extra", schema: effectUnion, value: { kind: "b", x: "1" } },
  { name: "effect array ok", schema: effectArray, value: { files: ["a", "b"] } },
  { name: "effect array empty", schema: effectArray, value: { files: [] } },
  { name: "effect array bad item", schema: effectArray, value: { files: ["a", 2, null] } },
  { name: "effect array not array", schema: effectArray, value: { files: "a" } },
  { name: "record anything", schema: { type: "object" }, value: { a: 1, b: [null] } },
  { name: "record not object", schema: { type: "object" }, value: [] },
  { name: "literals ok", schema: { type: "string", enum: ["a", "b"] }, value: "b" },
  { name: "literals bad", schema: { type: "string", enum: ["a", "b"] }, value: "c" },
  { name: "literals wrong type", schema: { type: "string", enum: ["a", "b"] }, value: 1 },
  // references
  {
    name: "defs recursive ok",
    schema: withDefs,
    value: { node: { name: "r", children: [{ name: "c", children: [] }] } },
  },
  {
    name: "defs recursive deep bad",
    schema: withDefs,
    value: { node: { name: "r", children: [{ name: "c", children: [{ nope: 1 }] }] } },
  },
  { name: "definitions ok", schema: withDefinitions, value: { id: "abc" } },
  { name: "definitions short and bad pattern", schema: withDefinitions, value: { id: "A1" } },
  { name: "definitions absent optional", schema: withDefinitions, value: {} },
  // foreign schema keywords
  { name: "mcp ok", schema: mcpLike, value: okMcp },
  { name: "mcp missing query", schema: mcpLike, value: {} },
  { name: "mcp query too long", schema: mcpLike, value: { query: "a".repeat(21) } },
  { name: "mcp query empty", schema: mcpLike, value: { query: "" } },
  { name: "mcp count out of range", schema: mcpLike, value: { query: "q", count: 11 } },
  { name: "mcp count float", schema: mcpLike, value: { query: "q", count: 1.5 } },
  { name: "mcp email format ignored", schema: mcpLike, value: { query: "q", email: "nope" } },
  { name: "mcp when string", schema: mcpLike, value: { query: "q", when: "now" } },
  { name: "mcp when number", schema: mcpLike, value: { query: "q", when: 1 } },
  { name: "mcp nullable tag string", schema: mcpLike, value: { query: "q", tag: "t" } },
  { name: "mcp nullable tag number", schema: mcpLike, value: { query: "q", tag: 1 } },
  { name: "mcp oneOf neither", schema: mcpLike, value: { query: "q", mode: "medium" } },
  { name: "mcp multipleOf bad", schema: mcpLike, value: { query: "q", ratio: 0.3 } },
  { name: "mcp tags too many", schema: mcpLike, value: { query: "q", tags: ["a", "b", "c", "d"] } },
  { name: "mcp tags duplicate", schema: mcpLike, value: { query: "q", tags: ["a", "a"] } },
  { name: "mcp tags empty", schema: mcpLike, value: { query: "q", tags: [] } },
  { name: "mcp pair wrong second", schema: mcpLike, value: { query: "q", pair: ["x", "y"] } },
  { name: "mcp pair too long", schema: mcpLike, value: { query: "q", pair: ["x", 1, 2] } },
  { name: "mcp meta bad key", schema: mcpLike, value: { query: "q", meta: { other: "1" } } },
  { name: "mcp meta bad value", schema: mcpLike, value: { query: "q", meta: { "x-a": 1 } } },
  { name: "mcp not violated", schema: mcpLike, value: { query: "q", not: "s" } },
  { name: "mcp props empty", schema: mcpLike, value: { query: "q", props: {} } },
  { name: "mcp props too many", schema: mcpLike, value: { query: "q", props: { a: 1, b: 2, c: 3 } } },
  { name: "mcp props bad name", schema: mcpLike, value: { query: "q", props: { A: 1 } } },
  { name: "mcp extra prop allowed", schema: mcpLike, value: { query: "q", extra: true } },
  // bare and odd
  { name: "true schema", schema: true, value: { anything: 1 } },
  { name: "false schema", schema: false, value: 1 },
  { name: "empty schema", schema: {}, value: null },
  { name: "const ok", schema: { const: { a: [1, 2] } }, value: { a: [1, 2] } },
  { name: "const bad", schema: { const: { a: [1, 2] } }, value: { a: [2, 1] } },
  { name: "type list ok", schema: { type: ["integer", "boolean"] }, value: true },
  { name: "type list bad", schema: { type: ["integer", "boolean"] }, value: "x" },
  { name: "integer as float whole", schema: { type: "integer" }, value: 3.0 },
  { name: "number NaN", schema: { type: "number" }, value: Number.NaN },
  { name: "allOf both", schema: { allOf: [{ type: "string" }, { minLength: 2 }] }, value: "a" },
  { name: "anyOf sub errors", schema: { anyOf: [{ type: "string" }, { type: "number", minimum: 5 }] }, value: 2 },
  { name: "oneOf two match", schema: { oneOf: [{ type: "number" }, { minimum: 0 }] }, value: 1 },
  { name: "exclusiveMaximum", schema: { type: "number", exclusiveMaximum: 3 }, value: 3 },
  {
    name: "additionalProperties schema",
    schema: { type: "object", additionalProperties: { type: "number" } },
    value: { a: 1, b: "x" },
  },
  {
    name: "nested extra prop",
    schema: {
      type: "object",
      properties: { o: { type: "object", properties: { a: { type: "number" } }, additionalProperties: false } },
    },
    value: { o: { a: 1, b: 2 } },
  },
  { name: "required on non-object ignored", schema: { required: ["a"] }, value: "s" },
  { name: "unknown keyword ignored", schema: { type: "string", "x-custom": 1, description: "d" }, value: "s" },
  { name: "invalid type name throws", schema: { type: "not-a-json-schema-type" }, value: {}, throws: true },
  { name: "invalid required throws", schema: { type: "object", required: "a" }, value: {}, throws: true },
]
