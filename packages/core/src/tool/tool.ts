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
import type { ToolCatalogue } from "../tool-catalogue"
import type { ToolTruncation } from "./truncation"

export interface Context {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
  /** Canonical paths of the files the user attached, resolved once for this provider turn.
   *  A mutation tool passes these to `permission.assert` so overwriting the user's own source
   *  asks first. See `session/runner/attachment-paths.ts`. */
  readonly attachmentPaths?: ReadonlySet<string>
  /** Permission/routing-filtered schemas kept out of the provider's resident tool array. Only the
   *  resident `tool_search` consumes these; ordinary tools should ignore them. */
  readonly deferredTools?: ReadonlyArray<ToolCatalogue.Source>
  /** Invoke a schema already disclosed by tool_search through the resident, cache-stable dispatcher. */
  readonly invokeDeferred?: (name: string, input: Record<string, unknown>) => Effect.Effect<ToolOutput, ToolFailure>
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
export type SideEffectClass = "read" | "idempotent-write" | "non-idempotent" | "external-unknown"
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
  /** Recovery semantics declared by the adapter. Omitted tools fail closed as external-unknown. */
  readonly sideEffect?: SideEffectClass
  readonly description: string
  readonly input: Input
  readonly output: Output
  readonly outputPreview?: ToolTruncation.PreviewPolicy
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
  readonly sideEffect: SideEffectClass
  readonly permission?: string
  readonly deferred?: boolean
  readonly outputPreview?: ToolTruncation.PreviewPolicy
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
    sideEffect: config.sideEffect ?? "external-unknown",
    outputPreview: config.outputPreview,
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
  readonly sideEffect?: SideEffectClass
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
    sideEffect: config.sideEffect ?? "external-unknown",
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

export const validateName = (name: string): Effect.Effect<void, RegistrationError> =>
  /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
    ? Effect.void
    : Effect.fail(new RegistrationError({ name, message: `Invalid tool name: ${name}` }))

/**
 * The permission action a tool DECLARED, or `undefined` when it declared none.
 *
 * Deliberately distinct from `permission` below, which applies the registered-name fallback and
 * therefore **cannot tell "declared nothing" from "declared its own name"** — the two are the same
 * answer at every consumer in the tree. Reading the raw declaration is the only way to separate them,
 * which is what makes the refusal in `validateRegistration` expressible at all.
 */
export const declaredPermission = (tool: AnyTool): string | undefined => runtimeOf(tool).permission

/**
 * The check a registration seam runs before a tool becomes visible: the key must be a legal tool
 * name, and it must not be the very action the tool already declares. Supersedes a bare
 * `validateName` call, which it performs first.
 *
 * ⚠️ **BOTH registration seams run this** — `ToolRegistry.register` and `ApplicationTools.register`.
 * A registration is the only kind of seam that can see the violation at all: `withPermission` runs
 * before the key exists, so it is structurally blind to its own no-op. The application seam has no
 * caller in shipping source, which is the reason to cover it rather than to skip it — ruling 6's
 * lesson is that a decision duplicated across call sites diverges at the one nobody exercises. Both
 * are pinned, each with a negative control, in `test/tool-permission-identity.test.ts`.
 *
 * ⚠️ **The second arm is a structural refusal, and it replaces a convention.**
 * `withPermission(tool, "<the name it is registered under>")` is a literal no-op — `permission` below
 * already falls back to the registered name — yet it reads as a permission gate at the exact seam
 * where a reader goes looking for one. Nine tools shipped one until 2026-07-29 (spawn · write · trash ·
 * revert · define_tool · quality_provision · register-app · reconfigure · edit); deleting them changed
 * no behaviour, which is the proof that they gated nothing. Deleting was half the job. This is the
 * other half: the no-op is now impossible to complete rather than merely swept for.
 *
 * ⚠️ **Both halves ship, and neither subsumes the other** (todo.md ruling 1). The static sweep in
 * `test/tool-permission-identity.test.ts` still fails on a call site in shipping source, because a
 * registration that never runs on this machine — a tool behind a config branch, a package whose tests
 * do not execute — never reaches this function; and this function still catches what no sweep can
 * read, a name computed at runtime (an app or an MCP server naming its own tool) or a decorated tool
 * hoisted into a variable before it is registered.
 *
 * A genuine REMAP is untouched and must stay that way — `apply_patch` → `edit`, `glob`/`grep` →
 * `explore`. If this ever refuses one of those, it is this function that is wrong, not the tool.
 */
export const validateRegistration = (name: string, tool: AnyTool): Effect.Effect<void, RegistrationError> =>
  validateName(name).pipe(
    Effect.flatMap((): Effect.Effect<void, RegistrationError> => {
      if (declaredPermission(tool) !== name) return Effect.void
      return Effect.fail(
        new RegistrationError({
          name,
          message:
            `Tool "${name}" declares the permission action "${name}" — the same name it is being ` +
            `registered under. That is a no-op rather than a gate: Tool.permission already falls back ` +
            `to the registered name, so the tool answers to "${name}" either way. Drop the ` +
            `Tool.withPermission wrap, or point it at the action this tool must actually answer to.`,
        }),
      )
    }),
  )

/**
 * Point a tool at a permission action OTHER than its own registered name, so one user rule governs
 * several tools. `apply_patch` → `edit` and `glob`/`grep` → `explore` are the live cases in the tree:
 * a rule about editing files must reach every tool that edits a file, whatever it is called.
 *
 * ⚠️ **Passing a tool's OWN registered name is REFUSED by `ToolRegistry.register`** — see
 * `validateRegistration` above, which carries the full rationale and names the one seam that does
 * not yet run it.
 *
 * ⚠️ **The refusal structurally CANNOT live here.** This function runs *before* the tool has a
 * registration key: `edit: Tool.withPermission(tool, "edit")` never shows this call the word `edit`,
 * because the key is the property name of the object literal it is being placed into. So it is blind
 * to its own no-op by construction, and only a seam that sees the key and the tool together — a
 * registration — can refuse it.
 */
export const withPermission = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
  permission: string,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), permission })
  return decorated
}

/** Keep a rarely used schema out of every provider request until `tool_search` discloses it. */
export const withDeferred = <Input extends SchemaType<any>, Output extends SchemaType<any>>(
  tool: Definition<Input, Output>,
) => {
  const decorated = Object.freeze({}) as Definition<Input, Output>
  runtimes.set(decorated, { ...runtimeOf(tool), deferred: true })
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
 *
 * ⚠️ **Consumers want THIS, not `declaredPermission`.** The `?? name` fallback is the whole gate, so
 * anything deciding what a tool answers to must go through here. `declaredPermission` exists for the
 * one question this function is unable to answer — *did the tool declare anything at all* — and the
 * one caller that needs it is `validateRegistration`.
 */
export const permission = (tool: AnyTool, name: string) => runtimeOf(tool).permission ?? name
export const isDeferred = (tool: AnyTool) => runtimeOf(tool).deferred === true
export const definition = (name: string, tool: AnyTool) => runtimeOf(tool).definition(name)
export const sideEffect = (tool: AnyTool) => runtimeOf(tool).sideEffect
export const outputPreview = (tool: AnyTool) => runtimeOf(tool).outputPreview ?? "balanced"
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
