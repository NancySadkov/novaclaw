export * as Tool from "./tool"

import {
  ToolDefinition,
  ToolFailure,
  ToolOutput,
  truncatedArgsMessage,
  truncatedArgsResult,
  type ToolCall,
} from "@novaclaw/llm"
import { Effect, JsonSchema, Schema } from "effect"
import type { AgentV2 } from "../agent"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"

export interface Context {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
  /** Canonical paths of the files the user attached, resolved once for this provider turn.
   *  A mutation tool passes these to `permission.assert` so overwriting the user's own source
   *  asks first. See `session/runner/attachment-paths.ts`. */
  readonly attachmentPaths?: ReadonlySet<string>
}

export type SchemaType<A> = Schema.Codec<A, any, never, never>

declare const TypeId: unique symbol

export interface Definition<Input extends SchemaType<any>, Output extends SchemaType<any>> {
  readonly [TypeId]: {
    readonly _Input: Input
    readonly _Output: Output
  }
}

export type AnyTool = Definition<any, any>
export const Failure = ToolFailure
export type Failure = ToolFailure

export class RegistrationError extends Schema.TaggedErrorClass<RegistrationError>()("Tool.RegistrationError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export type Content =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly data: string; readonly mime: string; readonly name?: string }

type Config<
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
  Structured extends SchemaType<any> = Output,
> = {
  readonly description: string
  readonly input: Input
  readonly output: Output
  readonly structured?: Structured
  readonly toStructuredOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => Schema.Schema.Type<Structured>
  readonly execute: (
    input: Schema.Schema.Type<Input>,
    context: Context,
  ) => Effect.Effect<Schema.Schema.Type<Output>, ToolFailure>
  readonly toModelOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => ReadonlyArray<Content>
}

type Runtime = {
  readonly permission?: string
  readonly definition: (name: string) => ToolDefinition
  readonly settle: (call: ToolCall, context: Context) => Effect.Effect<ToolOutput, ToolFailure>
}

const runtimes = new WeakMap<AnyTool, Runtime>()

export function make<
  Input extends SchemaType<any>,
  Output extends SchemaType<any>,
  Structured extends SchemaType<any> = Output,
>(config: Config<Input, Output, Structured>): Definition<Input, Structured> {
  const tool = Object.freeze({}) as Definition<Input, Structured>
  const definitions = new Map<string, ToolDefinition>()
  runtimes.set(tool, {
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition = new ToolDefinition({
        name,
        description: config.description,
        inputSchema: toJsonSchema(config.input),
        outputSchema: toJsonSchema(config.structured ?? config.output),
      })
      definitions.set(name, definition)
      return definition
    },
    settle: (call, context) =>
      Schema.decodeUnknownEffect(config.input)(call.input).pipe(
        Effect.mapError((error) => new ToolFailure({ message: `Invalid tool input: ${error.message}` })),
        Effect.flatMap((input) =>
          config.execute(input, context).pipe(
            Effect.flatMap((output) =>
              Schema.encodeEffect(config.output)(output).pipe(
                Effect.flatMap((output) => {
                  if (!config.structured || !config.toStructuredOutput)
                    return Effect.succeed({ output, structured: output })
                  return Schema.encodeEffect(config.structured)(config.toStructuredOutput({ input, output })).pipe(
                    Effect.map((structured) => ({ output, structured })),
                  )
                }),
                Effect.mapError(
                  (error) =>
                    new ToolFailure({
                      message: `Tool returned an invalid value for its output schema: ${error.message}`,
                    }),
                ),
              ),
            ),
            Effect.map(({ output, structured }) => ({
              structured,
              content:
                config.toModelOutput?.({ input, output }).map((part) =>
                  part.type === "text"
                    ? { type: "text" as const, text: part.text }
                    : {
                        type: "file" as const,
                        uri: `data:${part.mime};base64,${part.data}`,
                        mime: part.mime,
                        name: part.name,
                      },
                ) ?? (typeof output === "string" ? [{ type: "text" as const, text: output }] : []),
            })),
          ),
        ),
      ),
  })
  return tool
}

/**
 * Escape hatch for tools whose input is a raw JSON Schema and whose execution is
 * external — MCP servers and plugins — rather than an Effect-Schema-typed core tool.
 * `make` is Effect-Schema-first; dynamic MCP/plugin tools register through here instead
 * (see the note in `builtins.ts`). `execute` receives the already-parsed call input and
 * returns the model-facing `content` plus a `structured` value, mirroring `make`'s
 * settlement shape. The same conversion (`Content` → wire parts) as `make` is applied.
 *
 * ⚠️ **There is deliberately no `permission` option here** (deleted 2026-07-29). It existed, had
 * ZERO production callers — `mcp-external.ts` and `novaclaw/tool/external-tool-source.ts` both
 * omitted it — and its only value in the tree was a `"mcp"` test fixture. It was not merely
 * dormant, it was a trap: both dynamic-tool sources gate execution with
 * `permission.assert({ action: <the registered name> })`, so declaring anything else here would
 * have made the horizon filter (`registry.ts` `whollyDisabled`) and the execution gate resolve
 * DIFFERENT actions for the same tool — a horizon the model can see but cannot act on, which is
 * the exact failure `apply_patch`'s remap exists to prevent in the other direction. A dynamic tool
 * is governed by the name it is registered under; `test/tool-permission-identity.test.ts` pins that
 * and fails if this option comes back.
 */
export function makeExternal(config: {
  readonly description: string
  readonly inputSchema: JsonSchema.JsonSchema
  readonly outputSchema?: JsonSchema.JsonSchema
  readonly execute: (
    input: unknown,
    context: Context,
  ) => Effect.Effect<{ readonly structured: unknown; readonly content: ReadonlyArray<Content> }, ToolFailure>
}): AnyTool {
  const tool = Object.freeze({}) as AnyTool
  const definitions = new Map<string, ToolDefinition>()
  runtimes.set(tool, {
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition = new ToolDefinition({
        name,
        description: config.description,
        inputSchema: config.inputSchema,
        outputSchema: config.outputSchema ?? { type: "object" },
      })
      definitions.set(name, definition)
      return definition
    },
    settle: (call, context) =>
      config.execute(call.input, context).pipe(
        Effect.map((result) => ({
          structured: result.structured,
          content: result.content.map((part) =>
            part.type === "text"
              ? { type: "text" as const, text: part.text }
              : {
                  type: "file" as const,
                  uri: `data:${part.mime};base64,${part.data}`,
                  mime: part.mime,
                  name: part.name,
                },
          ),
        })),
      ),
  })
  return tool
}

export const validateName = (name: string) =>
  /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
    ? Effect.void
    : Effect.fail(new RegistrationError({ name, message: `Invalid tool name: ${name}` }))

/**
 * Point a tool at a permission action OTHER than its own registered name, so one user rule governs
 * several tools. `apply_patch` declaring `edit` is the only live case in the tree: a rule about
 * editing files must reach every tool that edits a file, whatever it is called.
 *
 * ⚠️ **Passing a tool's OWN registered name is a literal no-op** — `permission` below already falls
 * back to that name — so such a call adds nothing while reading as a guard. Nine of them
 * (spawn · write · trash · revert · define_tool · quality_provision · register-app · reconfigure ·
 * edit) were deleted on 2026-07-29 with no behaviour change; `test/tool-permission-identity.test.ts`
 * pins the equivalence by exercising the registry and fails if a tenth appears.
 */
export const withPermission = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  permission: string,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), permission })
  return decorated
}

/**
 * The action `ToolRegistry.materialize` resolves against the permission ruleset when it decides
 * whether a tool is withdrawn from the model's horizon (`whollyDisabled`, registry.ts) — the only
 * consumer in the tree.
 *
 * **The fallback IS the mechanism, and it is why almost nothing declares anything.** A tool that
 * declares nothing is governed by the name it was registered under, so
 * `{ action: "write", resource: "*", effect: "deny" }` withdraws `write` with not a word about
 * permissions anywhere in `write.ts`. Only a tool that must answer to a DIFFERENT action declares
 * one, and `apply_patch` → `edit` is the sole live declaration in the tree.
 *
 * ⚠️ **`withPermission` is now the ONLY way to declare one.** `makeExternal` used to take a
 * `permission` field — a second declaration surface with zero production callers — and it is gone
 * (see the note on `makeExternal` above). So a dynamic MCP or plugin tool is governed by its own
 * advertised name, which is also the action its source asserts at execution time. Do not describe
 * MCP as gated by a shared `mcp` action, and do not reintroduce a per-tool declaration that the
 * execution gate does not spend.
 */
export const permission = (tool: AnyTool, name: string) => runtimeOf(tool).permission ?? name
export const definition = (name: string, tool: AnyTool) => runtimeOf(tool).definition(name)
export const settle = (tool: AnyTool, call: ToolCall, context: Context) => {
  // 1O/A4: a truncated-args sentinel (the decoder's stand-in for a call whose streamed JSON the
  // server truncated) short-circuits BEFORE the tool's own schema decode, so EVERY tool inherits the
  // prescriptive "build the file in chunks" recovery instead of a generic "Invalid tool input". The
  // ToolFailure is lowered into an error-state tool result the model sees (feeds the 1N/A2 streak).
  const truncated = truncatedArgsMessage(call.input)
  if (truncated !== undefined)
    return Effect.fail(new ToolFailure({ message: truncatedArgsResult(call.name, truncated) }))
  return runtimeOf(tool).settle(call, context)
}

function runtimeOf(tool: AnyTool) {
  const runtime = runtimes.get(tool)
  if (!runtime) throw new TypeError("Invalid Core Tool value")
  return runtime
}

function toJsonSchema(schema: Schema.Top): JsonSchema.JsonSchema {
  const document = Schema.toJsonSchemaDocument(schema)
  if (Object.keys(document.definitions).length === 0) return document.schema
  return { ...document.schema, $defs: document.definitions }
}
