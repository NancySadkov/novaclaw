// Pure JSON-Schema helpers for plugin / config-dir tool definitions (from
// `@novaclaw/plugin`). A plugin tool exposes its args either as a Zod raw shape
// or as a raw JSON-Schema map; both branches must produce a JSON Schema for the
// LLM and (for Zod) a validator. These functions are self-contained and pure —
// they were originally inlined in the V1 `tool/registry.ts`; extracted here so
// the V2 `ExternalToolSource` aggregator (`tool/external-tool-source.ts`) and the
// legacy registry share ONE copy (and so they outlive the V1 registry's deletion
// in F1f). No Effect, no services — safe to import from either engine.

import { type ToolDefinition } from "@novaclaw/plugin"
import type { JSONSchema7, JSONSchema7Definition } from "json-schema"
import z from "zod"

export function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

export function isPluginTool(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && "args" in value && "description" in value && "execute" in value
}

/**
 * Compute the LLM-facing JSON Schema for a plugin tool's args, plus (when every
 * arg is Zod) the compiled `z.ZodObject` for input validation. The two callers
 * differ only in what they do with `zodParams`: the V1 registry wraps it in an
 * Effect-Schema `declare` for its `parameters`; the V2 source `safeParse`s with it.
 */
export function pluginToolSchema(def: ToolDefinition): { jsonSchema: JSONSchema7; zodParams?: z.ZodObject } {
  // Normalize missing args to `{}` once — pre-1.14.49 the code was
  // `z.object(def.args)` and Zod silently tolerated undefined (#27451, #27630).
  const args = def.args ?? {}
  const entries = Object.entries(args)
  const allZod = entries.every((entry) => isZodType(entry[1]))
  const zodParams = allZod ? z.object(args) : undefined
  const jsonSchema = zodParams ? zodJsonSchema(zodParams) : legacyJsonSchema(entries)
  return zodParams ? { jsonSchema, zodParams } : { jsonSchema }
}

function isJsonSchemaDefinition(value: unknown): value is JSONSchema7Definition {
  return typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))
}

function legacyJsonSchema(entries: [string, unknown][]): JSONSchema7 {
  const properties = Object.fromEntries(
    entries.filter((entry): entry is [string, JSONSchema7Definition] => isJsonSchemaDefinition(entry[1])),
  )
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
  }
}

function zodJsonSchema(schema: z.ZodType): JSONSchema7 {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isJsonSchemaObject(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return ($defs && isJsonSchemaObject($defs) ? { ...rest, definitions: $defs as JSONSchema7["definitions"] } : rest) as JSONSchema7
}

function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)

    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }

    for (const item of Object.values(value)) collect(item)
  }
  collect(schema)
  return registry
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeZodJsonSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) =>
        (entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"
          ? false
          : true,
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
