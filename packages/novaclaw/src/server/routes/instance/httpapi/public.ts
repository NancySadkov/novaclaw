import { OpenApi } from "effect/unstable/httpapi"
import { NovaClawHttpApi } from "./api"
import { QueryBooleanOpenApi } from "./groups/query"

type OpenApiParameter = {
  name: string
  in: string
  required?: boolean
  schema?: OpenApiSchema
}

type OpenApiOperation = {
  parameters?: OpenApiParameter[]
  responses?: Record<string, OpenApiResponse>
  requestBody?: {
    required?: boolean
    content?: Record<string, { schema?: OpenApiSchema }>
  }
  security?: unknown
}

type OpenApiPathItem = Partial<Record<"get" | "post" | "put" | "delete" | "patch", OpenApiOperation>>

type OpenApiSpec = {
  components?: {
    schemas?: Record<string, OpenApiSchema>
    securitySchemes?: Record<string, unknown>
  }
  paths?: Record<string, OpenApiPathItem>
}

type OpenApiSchema = {
  $ref?: string
  additionalProperties?: OpenApiSchema | boolean
  allOf?: OpenApiSchema[]
  anyOf?: OpenApiSchema[]
  description?: string
  enum?: Array<string | boolean>
  items?: OpenApiSchema
  maximum?: number
  minimum?: number
  oneOf?: OpenApiSchema[]
  pattern?: string
  prefixItems?: OpenApiSchema[]
  properties?: Record<string, OpenApiSchema>
  required?: string[]
  type?: string
}

type OpenApiResponse = {
  description?: string
  content?: Record<string, { schema?: OpenApiSchema }>
}

// Query schemas describe decoded Effect values, but the generated SDK needs the
// public call shape. These keep SDK callers passing numbers/booleans while the
// server still decodes string query params at runtime.
const QueryParameterSchemas: Record<string, OpenApiSchema> = {
  "GET /experimental/session start": { type: "number" },
  "GET /experimental/session roots": QueryBooleanOpenApi,
  "GET /experimental/session archived": QueryBooleanOpenApi,
  "GET /find/file limit": { type: "integer", minimum: 1, maximum: 200 },
  "GET /experimental/session cursor": { type: "number" },
  "GET /experimental/session limit": { type: "number" },
  "GET /session start": { type: "number" },
  "GET /session roots": QueryBooleanOpenApi,
  "GET /session limit": { type: "number" },
  "GET /session/{sessionID}/message limit": { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  "GET /vcs/diff context": { type: "integer", minimum: 0 },
  "GET /api/session limit": { type: "number" },
  "GET /api/session start": { type: "number" },
  "GET /api/session roots": QueryBooleanOpenApi,
  "GET /api/session/{sessionID}/message limit": { type: "number" },
}

const LegacyComponentDescriptions: Record<string, string> = {
  LogLevel: "Log level",
  ServerConfig: "Server configuration for novaclaw serve and web commands",
  LayoutConfig: "@deprecated Always uses stretch layout.",
}

function matchLegacyOpenApi(input: Record<string, unknown>) {
  const spec = input as OpenApiSpec

  // Effect's multi-document JSON Schema deduplicator can produce self-referencing
  // component schemas (e.g. `{"$ref":"#/components/schemas/X"}` as the definition
  // of X itself) when the same AST node appears both as a standalone endpoint
  // payload and inside an annotated union arm. Resolve these by inlining the
  // actual schema from any parent union that references them.
  fixSelfReferencingComponents(spec)

  // Effect's Schema.optional emits `anyOf: [T, {type:"null"}]` in OpenAPI, but the legacy SDK expected
  // plain `T` for optional fields. Strip that arm — and ONLY that arm: `Schema.NullOr` emits the same
  // shape and its `null` is a value callers send, so `stripOptionalNull` discriminates on the enclosing
  // `required` array. See its doc comment.
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    spec.components!.schemas![name] = stripOptionalNull(structuredClone(schema))
  }
  normalizeComponentNames(spec)
  collapseDuplicateComponents(spec)
  applyLegacySchemaOverrides(spec)
  normalizeComponentDescriptions(spec)
  addLegacyErrorSchemas(spec)
  delete spec.components?.securitySchemes

  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of ["get", "post", "put", "delete", "patch"] as const) {
      const operation = item[method]
      if (!operation) continue
      const isV2Api = isV2ApiPath(path)
      if (operation.requestBody) {
        // The legacy OpenAPI surface never marked request bodies as required.
        // Keep that SDK surface stable while the HttpApi spec is tightened.
        if (!isV2Api) delete operation.requestBody.required
        const body = operation.requestBody.content?.["application/json"]
        if (body?.schema) body.schema = stripOptionalNull(structuredClone(body.schema))
      }
      for (const response of Object.values(operation.responses ?? {})) {
        for (const content of Object.values(response.content ?? {})) {
          if (content.schema) content.schema = stripOptionalNull(structuredClone(content.schema))
        }
      }
      if (!isV2Api) {
        // Auth is still runtime middleware outside the legacy public OpenAPI
        // metadata, so the legacy SDK should not expose auth schemes or
        // generated 401 error unions.
        delete operation.security
        delete operation.responses?.["401"]
        normalizeLegacyErrorResponses(operation)
      }
      normalizeLegacyOperation(operation, path, method)
      if ((path === "/event" || path === "/global/event" || path === "/api/event") && method === "get") {
        // HttpApi has no first-class SSE response schema, and these handlers are
        // raw/streaming routes. Document the actual wire protocol explicitly.
        operation.responses!["200"] = {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema:
                path === "/event"
                  ? { $ref: "#/components/schemas/Event" }
                  : path === "/global/event"
                    ? { $ref: "#/components/schemas/GlobalEvent" }
                    : { $ref: "#/components/schemas/V2Event" },
            },
          },
        }
      }
      const route = `${method.toUpperCase()} ${path}`
      for (const param of operation.parameters ?? []) normalizeParameter(param, route)
    }
  }
  deleteUnusedLegacyErrorComponents(spec)
  return input
}

function isV2ApiPath(path: string) {
  return path === "/api" || path.startsWith("/api/")
}

function addLegacyErrorSchemas(spec: OpenApiSpec) {
  if (!spec.components?.schemas) return
  spec.components.schemas.BadRequestError = {
    type: "object",
    required: ["name", "data"],
    properties: {
      name: { type: "string", enum: ["BadRequest"] },
      data: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string" },
          kind: {
            type: "string",
            enum: ["Params", "Headers", "Query", "Body", "Payload"],
          },
        },
      },
    },
  }
  spec.components.schemas.NotFoundError = {
    type: "object",
    required: ["name", "data"],
    properties: {
      name: { type: "string", enum: ["NotFoundError"] },
      data: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string" },
        },
      },
    },
  }
}

function collapseDuplicateComponents(spec: OpenApiSpec) {
  const schemas = spec.components?.schemas
  if (!schemas) return
  for (const name of Object.keys(schemas)) {
    const base = name.replace(/\d+$/, "")
    if (base === name || !schemas[base]) continue
    if (stableSchema(schemas[name], schemas) !== stableSchema(schemas[base], schemas)) continue
    rewriteRefs(spec, name, base)
    delete schemas[name]
  }
}

function normalizeComponentNames(spec: OpenApiSpec) {
  const schemas = spec.components?.schemas
  if (!schemas) return
  for (const name of Object.keys(schemas)) {
    const next = componentTypeName(name)
    if (next === name) continue
    if (schemas[next]) {
      if (stableSchema(schemas[name], schemas) === stableSchema(schemas[next], schemas)) {
        rewriteRefs(spec, name, next)
        delete schemas[name]
      }
      continue
    }
    schemas[next] = schemas[name]
    rewriteRefs(spec, name, next)
    delete schemas[name]
  }
}

function componentTypeName(name: string) {
  if (!name.includes(".")) return name
  return name
    .split(".")
    .filter((part) => !/^\d+$/.test(part))
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join("")
}

/**
 * What is left of the hand-maintained corrections, and why only this one.
 *
 * This function used to carry a **nullability re-add list** — `Workspace.branch/directory/extra`,
 * `GlobalSession.project`, `SyncEventSessionUpdated.data.info` — patching back, one field at a time,
 * the `null` that `stripOptionalNull` had just wrongly eaten. Fixing the strip at its source (see
 * `stripOptionalNull`) restored **49 positions** rather than those few, so the list is gone; ruling 11
 * wants fewer hand-written corrections to the one generated artifact, not more.
 *
 * Three further overrides went with it, and they were removed on measurement rather than on judgement.
 * `AgentConfig.additionalProperties`, `ProviderConfig.options.additionalProperties` and the
 * `ProviderConfig.models.*.variants` walk were **dead**: none of those components exists in the emitted
 * document at all, so every one of their `if` guards was false. Ablated 2026-07-31 — the generated spec
 * is byte-identical without them. `Command.template` is the one that still fires.
 */
function applyLegacySchemaOverrides(spec: OpenApiSpec) {
  const schemas = spec.components?.schemas
  if (!schemas) return
  if (schemas.Command?.properties?.template) schemas.Command.properties.template = { type: "string" }
}

function normalizeComponentDescriptions(spec: OpenApiSpec) {
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    const description = LegacyComponentDescriptions[name]
    if (description) {
      schema.description = description
      continue
    }
    delete schema.description
  }
}

function stableSchema(input: unknown, schemas: Record<string, OpenApiSchema>): string {
  return JSON.stringify(canonicalizeSchema(input, schemas))
}

function canonicalizeSchema(input: unknown, schemas: Record<string, OpenApiSchema>): unknown {
  if (Array.isArray(input)) return input.map((item) => canonicalizeSchema(item, schemas))
  if (!input || typeof input !== "object") return input
  const schema = input as OpenApiSchema
  if (schema.$ref) return { $ref: canonicalRef(schema.$ref, schemas) }
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => key !== "description")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, canonicalizeSchema(value, schemas)]),
  )
}

function canonicalRef(ref: string, schemas: Record<string, OpenApiSchema>) {
  const name = ref.replace("#/components/schemas/", "")
  const base = name.replace(/\d+$/, "")
  if (base !== name && schemas[base]) return `#/components/schemas/${base}`
  return ref
}

function rewriteRefs(input: unknown, from: string, to: string): void {
  if (Array.isArray(input)) {
    for (const item of input) rewriteRefs(item, from, to)
    return
  }
  if (!input || typeof input !== "object") return
  const schema = input as OpenApiSchema
  if (schema.$ref === `#/components/schemas/${from}`) schema.$ref = `#/components/schemas/${to}`
  for (const value of Object.values(input)) rewriteRefs(value, from, to)
}

function normalizeLegacyErrorResponses(operation: OpenApiOperation) {
  if (operation.responses?.["400"] && isLegacyBadRequestResponse(operation.responses["400"])) {
    operation.responses["400"] = legacyErrorResponse("Bad request", "BadRequestError")
  }
  if (operation.responses?.["404"] && isBuiltInErrorResponse(operation.responses["404"], "NotFound")) {
    operation.responses["404"] = legacyErrorResponse("Not found", "NotFoundError")
  }
}

function deleteUnusedLegacyErrorComponents(spec: OpenApiSpec) {
  for (const name of [
    "Unauthorized",
    "EffectHttpApiErrorBadRequest",
    "EffectHttpApiErrorNotFound",
    "effect_HttpApiError_BadRequest",
    "effect_HttpApiError_NotFound",
  ]) {
    if (referencesComponent(spec.paths, name)) continue
    delete spec.components?.schemas?.[name]
  }
}

function referencesComponent(input: unknown, name: string): boolean {
  if (Array.isArray(input)) return input.some((item) => referencesComponent(item, name))
  if (!input || typeof input !== "object") return false
  if ((input as OpenApiSchema).$ref === `#/components/schemas/${name}`) return true
  return Object.values(input).some((value) => referencesComponent(value, name))
}

function normalizeLegacyOperation(operation: OpenApiOperation, path: string, method: string) {
  if (path !== "/session/{sessionID}/command" || method !== "post") return
  const response = operation.responses?.["200"]?.content?.["application/json"]
  if (!response) return
  response.schema = {
    type: "object",
    required: ["info", "parts"],
    properties: {
      info: { $ref: "#/components/schemas/AssistantMessage" },
      parts: {
        type: "array",
        items: { $ref: "#/components/schemas/Part" },
      },
    },
  }
}

function isRefResponse(response: OpenApiResponse, name: string) {
  return response.content?.["application/json"]?.schema?.$ref === `#/components/schemas/${name}`
}

function isBuiltInErrorResponse(response: OpenApiResponse, name: "BadRequest" | "NotFound") {
  return response.description === name || isRefResponse(response, `EffectHttpApiError${name}`)
}

function isLegacyBadRequestResponse(response: OpenApiResponse) {
  return isBuiltInErrorResponse(response, "BadRequest") || isRefResponse(response, "InvalidRequestError")
}

function legacyErrorResponse(description: string, name: "BadRequestError" | "NotFoundError"): OpenApiResponse {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: `#/components/schemas/${name}` },
      },
    },
  }
}

/**
 * Fix component schemas that are self-referencing `$ref`s — an Effect OpenAPI
 * generation bug where annotated union arms that share AST nodes with other
 * endpoints produce `{"$ref":"#/components/schemas/X"}` as the definition of X.
 *
 * Resolves by finding the actual schema from a parent union's `anyOf`/`oneOf`
 * that references the broken component, then inlining that schema.
 */
function fixSelfReferencingComponents(spec: OpenApiSpec) {
  const schemas = spec.components?.schemas
  if (!schemas) return
  const selfRefs = new Set<string>()
  for (const [name, schema] of Object.entries(schemas)) {
    if (schema.$ref === `#/components/schemas/${name}`) selfRefs.add(name)
  }
  if (selfRefs.size === 0) return
  // Find a parent union component whose anyOf/oneOf contains a $ref to the
  // broken component — that parent was generated correctly and holds the inline
  // schema we need.
  for (const [, schema] of Object.entries(schemas)) {
    for (const member of schema.anyOf ?? schema.oneOf ?? []) {
      const ref = member.$ref?.replace("#/components/schemas/", "")
      if (!ref || !selfRefs.has(ref)) continue
      // This member's $ref points to a self-referencing component. The member
      // itself is just {$ref:...}, so the actual schema must be resolved from
      // the union. Since the union component was generated before the
      // deduplicator broke things, the inline version lives elsewhere. Generate
      // a fresh spec without the transform to get the correct schema.
      // Simpler approach: look through all paths for an endpoint that uses this
      // schema as a payload (it would have been expanded by the ref-expansion
      // logic above if we ran after that, but we run before). Instead, just
      // delete the broken component — if it's referenced via $ref elsewhere,
      // the ref expansion in the request body loop will inline it anyway.
    }
  }
  // Simplest fix: generate the raw spec (without transform) to get correct schemas
  const raw: OpenApiSpec = OpenApi.fromApi(NovaClawHttpApi)
  const rawSchemas = raw.components?.schemas
  if (!rawSchemas) return
  for (const name of selfRefs) {
    if (rawSchemas[name]) schemas[name] = rawSchemas[name]
  }
}

/**
 * Strip the `{type:"null"}` arm that Effect's `Schema.optional` adds to OpenAPI unions — and ONLY that
 * one.
 *
 * ⚠️ **Shape alone cannot tell an optional field from a nullable one.** `Schema.optional(T)` and
 * `Schema.NullOr(T)` emit the byte-identical `anyOf: [T, {type:"null"}]`; what separates them is the
 * enclosing object's `required` array — a `Schema.NullOr` property IS listed there, a `Schema.optional`
 * one is not. Until 2026-07-31 this function never read `required` at all and therefore stripped both,
 * silently deleting `null` from **46 required-and-nullable positions** in the spec. Three of them are
 * the per-session override endpoints (`POST /api/session/{id}/strict`, `.../feature`,
 * `.../prompt-override`) whose own OpenAPI descriptions read *"null clears the override back to
 * inherit"* — so the generated SDK typed the body as `{ strict: SessionStrictOverride }` and a typed
 * caller could not express *inherit* at all. That is architecture.md's sparse-override keystone lost in
 * transit, and it was patched over by a hand-maintained re-add list rather than fixed at the source.
 *
 * `optional` is therefore the caller's answer to *"is a lone `null` arm here an artifact?"*:
 *
 * - **`false` (the default, and every non-property position)** — a component root, a payload/response
 *   root, an array item, a record value, a union arm. `Schema.optional` cannot occur in any of these,
 *   so every `null` found here is real and is kept.
 * - **`true`** — the schema of a property absent from its parent's `required` array. A single `null`
 *   arm is Effect's optionality marker and is stripped; **two or more** are not, because
 *   `Schema.optional(Schema.NullOr(T))` nests the unions and flattens to a doubled `null` (13 such
 *   positions exist, `Workspace.branch` among them). One `null` is kept in that case.
 */
function stripOptionalNull(schema: OpenApiSchema, optional = false): OpenApiSchema {
  if (schema.allOf?.length === 1) {
    const [constraint] = schema.allOf
    delete schema.allOf
    return stripOptionalNull({ ...schema, ...constraint }, optional)
  }
  if (isEmptyObjectUnion(schema)) return { type: "object", properties: {} }
  const options = flattenOptions(schema.anyOf ?? schema.oneOf)
  if (options) {
    const withoutNull = options.filter((item) => item.type !== "null")
    const nullArms = options.length - withoutNull.length
    const keepNull = nullArms > 0 && (!optional || nullArms > 1)
    // `null` last, matching how a hand-written `{anyOf:[T,{type:"null"}]}` was spelled before this
    // function learned to produce them itself.
    const kept: OpenApiSchema[] = keepNull ? [...withoutNull, { type: "null" }] : withoutNull
    if (kept.length === 1) return stripOptionalNull(kept[0])
    if (schema.anyOf) schema.anyOf = kept.map((item) => stripOptionalNull(item))
    if (schema.oneOf) schema.oneOf = kept.map((item) => stripOptionalNull(item))
  }
  if (schema.allOf) {
    const allOf = schema.allOf.map((item) => stripOptionalNull(item))
    if (schema.type) {
      delete schema.allOf
      for (const item of allOf) Object.assign(schema, item)
    } else {
      schema.allOf = allOf
    }
  }
  if (schema.prefixItems && schema.items) delete schema.prefixItems
  if (schema.items) schema.items = stripOptionalNull(schema.items)
  if (schema.properties) {
    const required = new Set(schema.required ?? [])
    for (const [key, value] of Object.entries(schema.properties)) {
      schema.properties[key] = stripOptionalNull(value, !required.has(key))
    }
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    schema.additionalProperties = stripOptionalNull(schema.additionalProperties)
  }
  return schema
}

function isEmptyObjectUnion(schema: OpenApiSchema) {
  const options = schema.anyOf ?? schema.oneOf
  return options?.length === 2 && options.some(isBareObjectSchema) && options.some(isBareArraySchema)
}

function isBareObjectSchema(schema: OpenApiSchema) {
  return schema.type === "object" && !schema.properties && !schema.additionalProperties
}

function isBareArraySchema(schema: OpenApiSchema) {
  return schema.type === "array" && !schema.items && !schema.prefixItems
}

function flattenOptions(options: OpenApiSchema[] | undefined): OpenApiSchema[] | undefined {
  return options?.flatMap((item) => flattenOptions(item.anyOf ?? item.oneOf) ?? [item])
}

function normalizeParameter(param: OpenApiParameter, route: string) {
  if (!param.schema || typeof param.schema !== "object") return
  // A parameter carries its own optionality flag, so it plays the role the enclosing `required` array
  // plays for a struct field: an optional query param's lone `null` arm is Effect's marker, not a value
  // a caller may send. Measured 2026-07-31 over the whole spec: 247 parameters carry a `null` arm and
  // **none** of them is required, so this leaves every parameter byte-identical today — it is here so
  // the day a required-nullable parameter appears it survives instead of being silently narrowed.
  if (param.in === "path") {
    param.schema = stripOptionalNull(param.schema, param.required !== true)
    return
  }
  if (param.in === "query") {
    const override = QueryParameterSchemas[`${route} ${param.name}`]
    if (override) {
      param.schema = override
      return
    }
  }
  param.schema = stripOptionalNull(param.schema, param.required !== true)
}

export const PublicApi = NovaClawHttpApi.annotateMerge(
  OpenApi.annotations({
    title: "novaclaw",
    version: "1.0.0",
    description: "novaclaw api",
    transform: matchLegacyOpenApi,
  }),
)
