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
import { PermissionV2 } from "../permission"
import type { SessionMessage } from "../session/message"
import type { SessionSchema } from "../session/schema"
import type { ToolCatalogue } from "../tool-catalogue"
import type { ToolTruncation } from "./truncation"

export interface Context {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
  /** The catalog identity that actually runs this turn, after default, availability and health fallbacks.
   * Optional only for direct/non-runner tool execution, where no model has run. The session runner always supplies it. */
  readonly model?: {
    readonly providerID: string
    readonly id: string
    readonly name?: string
  }
  /** Server-owned Working receipt. `begin` returns the exact close handle, so parallel tool spans
   * cannot close one another merely because they share a phase name. */
  readonly timing?: {
    readonly begin: (phase: SessionMessage.TurnPhase) => Effect.Effect<() => Effect.Effect<void>>
  }
  /** Canonical paths of the files the user attached, resolved once for this provider turn.
   *  A mutation tool passes these to `permission.assert` so overwriting the user's own source
   *  asks first. See `session/runner/attachment-paths.ts`. */
  readonly attachmentPaths?: ReadonlySet<string>
  /** Permission/routing-filtered schemas kept out of the provider's resident tool array. Only the
   *  resident `tool_search` consumes these; ordinary tools should ignore them. */
  readonly deferredTools?: ReadonlyArray<ToolCatalogue.Source>
  /** Invoke a schema already disclosed by tool_search through the resident, cache-stable dispatcher. */
  readonly invokeDeferred?: (name: string, input: Record<string, unknown>) => Effect.Effect<ToolOutput, ToolFailure>
  /**
   * How many images this ASSISTANT TURN has already been handed, and how many the endpoint accepts
   * in one request. Absent when the endpoint declares no cap.
   *
   * 🔴 **Why a tool needs to know this.** Within one assistant turn there is no assistant text
   * between tool calls, so an image read after the cap is reached is *guaranteed* to be undescribed
   * — the model has had no opportunity to say what the earlier ones showed. `budgetImages` then
   * elides the oldest, and measured 2026-08-20 the model does not merely lose them, it CONFABULATES:
   * asked to describe six glyphs it read all six, three were evicted, and it invented a crown, a
   * shield and a helmet that do not exist.
   *
   * Three informational levers were tried first and none converted (the `read` note, the perception
   * wording, the path in the eviction notice). This is the mechanical one: a tool that would hand
   * over pixels the request cannot carry returns TEXT instead, which ends the turn and makes the
   * model speak — and speaking is what makes the images it already holds survive as descriptions.
   */
  readonly imageBudget?: {
    readonly limit: number
    readonly held: number
  }
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
  /**
   * Narrowed inputs a turn may be OFFERED instead of the whole schema, by key.
   *
   * 🔴 For withholding part of a tool rather than all of it. Our standing constraint is that a wholly
   * denied tool is withdrawn, never advertised and refused — and the same reasoning applies one level
   * down: `colleague` at the hop cap should stop offering `ask`, while `list`, `hire` and `retire`
   * have nothing to do with the bound and must stay.
   *
   * ⚠️ **Advertised only.** `settle` still decodes against the FULL `input`, so a model that calls a
   * withheld op anyway is refused by the bound that withheld it rather than crashing on a schema it
   * was never shown. Narrowing the executable surface as well would make a withheld op a hard error,
   * which is a worse answer to the same question.
   *
   * ⚠️ The definition cache below keys on name AND variant, so a variant costs one extra
   * `toJsonSchema` per process — not one per turn.
   */
  readonly variants?: Readonly<Record<string, Schema.Top>>
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
  readonly definition: (name: string, variant?: string | undefined) => ToolDefinition
  readonly settle: (call: ToolCall, context: Context) => Effect.Effect<ToolOutput, ToolFailure>
}

/** A schema-only registration whose implementation is resolved by the location's lazy owner.
 * It goes through the same settlement, permission and output gates as every other registration. */
export function lazy(config: {
  readonly definition: ToolDefinition
  readonly sideEffect: SideEffectClass
  readonly load: Effect.Effect<AnyTool, ToolFailure>
}): AnyTool {
  const tool = Object.freeze({}) as AnyTool
  runtimes.set(tool, {
    deferred: true,
    sideEffect: config.sideEffect,
    definition: (name) => new ToolDefinition({ ...config.definition, name }),
    settle: (call, context) =>
      config.load.pipe(Effect.flatMap((implementation) => settle(implementation, call, context))),
  })
  return tool
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
    definition: (name, variant) => {
      // Keyed on both, so a variant is a second cache entry rather than a recomputation per turn.
      const key = variant === undefined ? name : `${name}#${variant}`
      const cached = definitions.get(key)
      if (cached) return cached
      const narrowed = variant === undefined ? undefined : config.variants?.[variant]
      const definition = new ToolDefinition({
        name,
        description: config.description,
        inputSchema: toJsonSchema(narrowed ?? config.input),
        outputSchema: toJsonSchema(config.structured ?? config.output),
      })
      definitions.set(key, definition)
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
export const definition = (name: string, tool: AnyTool, variant?: string) => runtimeOf(tool).definition(name, variant)
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

/**
 * **THE tool error absorber (1J).** Lower a tool's error channel into the `ToolFailure` its contract
 * declares, *without destroying a permission refusal on the way*.
 *
 * 🔴 **Why this is a function and not a shape people copy.** Twenty tools in this directory carried a
 * byte-similar three-arm version of it, and four had drifted into absorbers that never consult
 * `denialMessage` at all. Measured 2026-09-01 by constructing a real
 * `PermissionV2.DeniedError({rules: [{action: "js", resource: "*", effect: "deny"}], reason:
 * "ask-removed"})` and running each site's expression over it:
 *
 * - `denialMessage` → the crafted deny-fast paragraph ("…retrying will not change it…").
 * - `js.ts`'s `error instanceof Error ? error.message : String(error)` → **`""`**. `DeniedError`
 *   declares only `rules` and `reason` (`permission.ts:152`), so it carries no message and the model
 *   was handed an EMPTY string.
 * - `computer.ts`'s `` `computer: ${String(error)}` `` → **`"computer: PermissionV2.DeniedError"`**.
 * - `skill.ts`'s `Unable to load skill <name>` → the same sentence a MISSING skill produces, so a
 *   refusal and a not-found were indistinguishable.
 *
 * `todowrite.ts` records the cost of exactly this collapse: a refusal that reads like a transient
 * fault is *"therefore worth retrying, which is exactly the loop the deny-fast text exists to stop"*.
 * In Analyze mode `MODE_RULES.plan` hard-denies `js`, so that loop was reachable in the product.
 *
 * ⚠️ **Order is the whole point.** An already-shaped `ToolFailure` passes through untouched (a tool
 * that failed on purpose has already said what it means); then `denialMessage`, so a refusal keeps
 * its identity including the user's reject feedback and a `novaclaw.json` exclusion's own wording;
 * only then the tool's fallback. A fallback consulted first is the defect, every time.
 *
 * `fallback` may be a string or a function of the error, because several tools legitimately want to
 * quote the underlying fault ("Unable to trash <path>: <why>"). It is only ever reached for errors
 * `denialMessage` does not answer.
 *
 * The guard against re-drift is `tool/absorb-ledger.test.ts`: every tool module that calls
 * `permission.assert` must reach `denialMessage`, via this helper or its own `mapError`.
 */
export const absorb =
  (fallback: string | ((error: unknown) => string)) =>
  (error: unknown): ToolFailure => {
    if (error instanceof ToolFailure) return error
    const denial = PermissionV2.denialMessage(error)
    if (denial) return new ToolFailure({ message: denial })
    return new ToolFailure({ message: typeof fallback === "function" ? fallback(error) : fallback, error })
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
