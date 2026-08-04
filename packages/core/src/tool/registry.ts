export * as ToolRegistry from "./registry"

import {
  ToolFailure,
  ToolOutput,
  ToolRuntime,
  type ToolCall,
  type ToolDefinition,
  type ToolResultValue,
} from "@novaclaw/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { ToolCatalogue } from "../tool-catalogue"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { ExternalToolSource } from "./external-tool-source"
import {
  definition,
  isDeferred,
  outputPreview,
  permission,
  settle,
  sideEffect,
  validateRegistration,
  type AnyTool,
  type Context as ToolContext,
  type RegistrationError,
} from "./tool"
import { Tools } from "./tools"
import { makeLocationNode } from "../effect/app-node"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  /** Canonical paths of the user's attachments for this turn; forwarded to every tool's Context. */
  readonly attachmentPaths?: ReadonlySet<string>
  readonly call: ToolCall
}

export interface Interface {
  /** Every currently registered canonical tool, before per-agent visibility filters. */
  readonly catalogue: () => Effect.Effect<ReadonlyArray<ToolCatalogue.Source>>
  readonly materialize: (
    permissions?: PermissionV2.Ruleset,
    offered?: (name: string) => boolean,
    discovered?: ReadonlySet<string>,
  ) => Effect.Effect<Materialization>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly sideEffects: Readonly<Record<string, import("./tool").SideEffectClass>>
  /** Filtered schemas intentionally absent from `definitions` until discovered. */
  readonly deferred: ReadonlyArray<ToolCatalogue.Source>
  readonly settle: (input: ExecuteInput) => Effect.Effect<Settlement, ToolOutputStore.Error>
}

export interface Settlement {
  readonly result: ToolResultValue
  readonly output?: ToolOutput
  readonly outputPaths?: ReadonlyArray<string>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ToolRegistry") {}

// The unknown-tool horizon lives in `@novaclaw/llm` — `ToolRuntime.unknownToolMessage`, implemented in
// packages/llm/src/unknown-tool.ts, which carries the full rationale (why naming the tools that DO exist is
// the difference between a dead turn and a recoverable one, and why the empty-registry branch and the
// character budget are both load-bearing).
//
// It used to be defined HERE — it shipped in this file, ported from github.com/NancySadkov/novaclaw PR #4
// (@DassaultFalconKing) — and moved down the dependency edge on 2026-07-28 because a second dispatch seam
// (`ToolRuntime.dispatch`) was still handing back a bare `Unknown tool: X`. Two seams answering the same
// question two ways is ruling 6's forbidden shape; `core` depends on `llm` and not the reverse, so `llm` is
// the only end that can hold the shared gate. **Do not re-add a copy here** — the check that keeps that
// sentence true rather than aspirational is `test/tool-registry.test.ts` → "there is exactly ONE
// unknown-tool message".

/** Keyed by the tool VALUE, so a registration never has to carry an extra field. See below. */
const availabilityOf = new WeakMap<AnyTool, Effect.Effect<boolean>>()
const deferredDispatchers = new WeakSet<AnyTool>()

/** Grant one trusted resident tool the per-materialization deferred dispatcher. The capability is
 *  keyed by tool identity so the registry never learns a magic registration name. */
export const withDeferredDispatcher = <T extends AnyTool>(tool: T): T => {
  deferredDispatchers.add(tool)
  return tool
}

/**
 * Declare a live availability predicate for a tool: `materialize` evaluates it when the model's
 * horizon is built, and withdraws the tool for that horizon when it answers `false`.
 *
 * ⚠️ **This is one of THREE horizon filters, and it is deliberately generic — the registry must
 * never learn a tool's name.** `whollyDisabled` below withdraws a tool the permission ruleset wholly
 * denies; the caller's pure routing predicate withdraws model-specific variants. This one withdraws
 * a tool whose OWN module says it is unavailable right
 * now, and the reason it exists is todo.md **ruling 3** (*read every runtime-editable value through
 * to its store at the point of use; a settings change is not a reboot*): a tool that decides its
 * availability from config cannot decide it once, at `Layer.effect` scope, because that answer is
 * frozen until the whole location is torn down. `tool/profile.ts` is the only such tool in the tree
 * and carries the full design argument, including the two options that were rejected.
 *
 * All three filters answer the same question — *is this tool on the horizon* — and answer it in one
 * place, which is what ruling 6 asks for. None advertises-then-refuses: a withdrawn tool is
 * absent from `definitions`, and a call arriving for it from an older horizon is settled by
 * `ToolRuntime.unknownToolMessage`, which names the tools that DO exist.
 *
 * **Cost.** `materialize` runs per turn AND per step (`session/runner/llm.ts`), so a predicate is on
 * a hot path. Only a tool that declares one pays anything — the `WeakMap` lookup for every other
 * tool is a miss and the loop is unchanged — but the declaring module owes a measurement. Measured
 * for the one live predicate (2026-07-31, 28 tools on the horizon): `materialize()` is 0.029 ms/call
 * with no predicate evaluated and 0.570 ms/call with `profile`'s, i.e. one `SELECT` over
 * `runtime_setting`. Numbers and the ceiling live in `test/tool-profile-availability.test.ts`.
 *
 * ⚠️ **Apply this LAST, to the exact value being registered.** It keys on the tool object, and
 * `Tool.withPermission` returns a NEW object carrying a copy of the tool's runtime — so
 * `withAvailability(withPermission(t, "edit"), p)` works and `withPermission(withAvailability(t, p),
 * "edit")` silently loses the predicate. Pinned both ways in `test/tool-profile-availability.test.ts`.
 */
export const withAvailability = <T extends AnyTool>(tool: T, available: Effect.Effect<boolean>): T => {
  availabilityOf.set(tool, available)
  return tool
}

const registryLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const applications = yield* ApplicationTools.Service
    const external = yield* ExternalToolSource.Service
    const resources = yield* ToolOutputStore.Service
    type Registration = { readonly identity: object; readonly tool: AnyTool }
    const local = new Map<string, Array<{ readonly token: object; readonly registration: Registration }>>()

    const settleRaw = Effect.fn("ToolRegistry.settleRaw")(function* (
      input: ExecuteInput,
      advertised: object,
      deferredTools: ReadonlyArray<ToolCatalogue.Source>,
      invokeDeferred?: ToolContext["invokeDeferred"],
    ) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ??
        applications.entries().get(input.call.name) ??
        (yield* external.entries()).get(input.call.name)
      if (!registration || registration.identity !== advertised)
        return yield* new ToolFailure({ message: `Stale tool call: ${input.call.name}` })
      const output = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
        attachmentPaths: input.attachmentPaths ?? new Set(),
        ...(deferredTools.length === 0 ? {} : { deferredTools }),
        ...(invokeDeferred === undefined || !deferredDispatchers.has(registration.tool) ? {} : { invokeDeferred }),
      })
      return { output, tool: registration.tool }
    })

    // `advertised` is the identity materialization handed to the model, and it is always supplied: the only
    // caller resolves the registration first and reports an unadvertised name itself
    // (`ToolRuntime.unknownToolMessage`). Reaching the raw executor with no matching registration therefore
    // means it was removed mid-turn — stale, never unknown.
    const settleWith = Effect.fn("ToolRegistry.settle")(function* (
      input: ExecuteInput,
      advertised: object,
      deferredTools: ReadonlyArray<ToolCatalogue.Source>,
      invokeDeferred?: ToolContext["invokeDeferred"],
    ) {
      const pending = yield* settleRaw(input, advertised, deferredTools, invokeDeferred).pipe(
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const bounded = yield* resources.bound({
        sessionID: input.sessionID,
        toolCallID: input.call.id,
        output,
        preview: outputPreview(pending.tool),
      })
      const result = ToolOutput.toResultValue(bounded.output)
      if (result.type === "error")
        return bounded.outputPaths.length > 0 ? { result, outputPaths: bounded.outputPaths } : { result }
      return bounded.outputPaths.length > 0
        ? { result, output: bounded.output, outputPaths: bounded.outputPaths }
        : { result, output: bounded.output }
    })

    return Service.of({
      register: Effect.fn("ToolRegistry.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        // ⚠️ A PRE-PASS over every entry, and that ordering is load-bearing (todo.md ruling 2 — a
        // failed mutation never reports success): validation completes for the whole batch before the
        // uninterruptible block below touches `local`, so one refused entry takes its siblings with
        // it rather than leaving half a registration behind. Keep any new check here, not in the loop.
        //
        // `validateRegistration` — not `validateName` — because a registration is the only kind of
        // seam that holds the key and the tool together, and therefore the only kind that can see a
        // tool declaring the very name it is being registered under. `Tool.withPermission` runs before
        // the key exists, so it is blind to that no-op by construction; see the note on it in
        // `tool.ts`, which also names the one other registration seam (`ApplicationTools.register`)
        // that still runs the weaker `validateName`.
        yield* Effect.forEach(entries, ([name, tool]) => validateRegistration(name, tool), { discard: true })
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const token = {}
            for (const [name, tool] of entries)
              local.set(name, [...(local.get(name) ?? []), { token, registration: { identity: {}, tool } }])
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                for (const [name] of entries) {
                  const registrations = local.get(name)?.filter((registration) => registration.token !== token) ?? []
                  if (registrations.length > 0) local.set(name, registrations)
                  else local.delete(name)
                }
              }),
            )
          }),
        )
      }),
      catalogue: Effect.fn("ToolRegistry.catalogue")(function* () {
        const sources = new Map<string, ToolCatalogue.Source>()
        for (const [name, registration] of applications.entries())
          sources.set(name, { server: "application", definition: definition(name, registration.tool) })
        for (const [name, registration] of yield* external.entries())
          sources.set(name, {
            server: ToolCatalogue.externalServer(name),
            definition: definition(name, registration.tool),
          })
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) sources.set(name, { server: "core", definition: definition(name, registration.tool) })
        }
        return [...sources.values()].toSorted((a, b) => a.definition.name.localeCompare(b.definition.name))
      }),
      materialize: Effect.fn("ToolRegistry.materialize")(function* (
        permissions = [],
        offered = () => true,
        discovered = new Set<string>(),
      ) {
        type MaterializedRegistration = Registration & { readonly server: string; readonly deferred: boolean }
        const registrations = new Map<string, MaterializedRegistration>()
        for (const [name, entry] of applications.entries())
          registrations.set(name, { ...entry, server: "application", deferred: false })
        for (const [name, entry] of yield* external.entries())
          registrations.set(name, { ...entry, server: ToolCatalogue.externalServer(name), deferred: true })
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration)
            registrations.set(name, { ...registration, server: "core", deferred: isDeferred(registration.tool) })
        }
        // Three withdrawals, one seam. Permission decides first and permanently removes a denied
        // registration. Routing runs only over survivors, so a `true` route decision can undo an
        // earlier ROUTING decision but can never resurrect a permission-withdrawn tool. Live tool
        // availability runs last, and a routed-off tool never pays its predicate's I/O.
        for (const [name, registration] of registrations) {
          if (whollyDisabled(permission(registration.tool, name), permissions)) {
            registrations.delete(name)
            continue
          }
          if (!offered(name)) {
            registrations.delete(name)
            continue
          }
          const available = availabilityOf.get(registration.tool)
          if (available !== undefined && !(yield* available)) registrations.delete(name)
        }
        const resident = new Map([...registrations].filter(([, registration]) => !registration.deferred))
        const deferred = [...registrations]
          .filter(([, registration]) => registration.deferred)
          .map(([name, registration]) => ({
            server: registration.server,
            definition: definition(name, registration.tool),
          }))
          .toSorted((a, b) => a.definition.name.localeCompare(b.definition.name))
        const deferredByName = new Map(
          deferred.map((source) => [source.definition.name, registrations.get(source.definition.name)!]),
        )
        const callableDeferred = new Map([...deferredByName].filter(([name]) => discovered.has(name)))
        const callableNames = [...resident.keys(), ...callableDeferred.keys()]
        return {
          definitions: Array.from(resident, ([name, registration]) => definition(name, registration.tool)),
          sideEffects: Object.fromEntries(
            [...resident, ...callableDeferred].map(([name, registration]) => [name, sideEffect(registration.tool)]),
          ),
          deferred,
          settle: (input) => {
            const registration = resident.get(input.call.name) ?? callableDeferred.get(input.call.name)
            const invokeDeferred: NonNullable<ToolContext["invokeDeferred"]> = (name, targetInput) => {
              const target = callableDeferred.get(name)
              if (!target) {
                if (resident.has(name))
                  return Effect.fail(
                    new ToolFailure({
                      message:
                        `${name} is a resident provider-native tool already advertised in this turn. ` +
                        `Call ${name} directly as the tool name; do not use tool_call or tool_search for resident tools.`,
                    }),
                  )
                return Effect.fail(
                  new ToolFailure({
                    message:
                      `Deferred tool ${name} is not callable in this session. ` +
                      `Call tool_search first and use an exact name it returned.`,
                  }),
                )
              }
              return settleRaw(
                { ...input, call: { type: "tool-call", id: input.call.id, name, input: targetInput } },
                target.identity,
                deferred,
              ).pipe(Effect.map((settled) => settled.output))
            }
            if (registration) return settleWith(input, registration.identity, deferred, invokeDeferred)
            if (deferredByName.has(input.call.name))
              return Effect.succeed({
                result: {
                  type: "error",
                  value:
                    `Tool ${input.call.name} is installed but its schema has not been disclosed in this session. ` +
                    `Nothing ran. Call tool_search for the capability you need, then invoke an exact returned name through tool_call.`,
                },
              })
            return Effect.succeed({
              result: { type: "error", value: ToolRuntime.unknownToolMessage(input.call.name, callableNames) },
            })
          },
        }
      }),
    })
  }),
)

export const layer = Layer.effect(
  Tools.Service,
  Service.use((registry) => Effect.succeed(Tools.Service.of({ register: registry.register }))),
).pipe(Layer.provideMerge(registryLayer))

function whollyDisabled(action: string, rules: PermissionV2.Ruleset) {
  const rule = rules.findLast((rule) => Wildcard.match(action, rule.action))
  return rule?.resource === "*" && rule.effect === "deny"
}

export const defaultLayer = layer.pipe(
  Layer.provide(ApplicationTools.layer),
  Layer.provide(ExternalToolSource.layer),
  Layer.provide(ToolOutputStore.defaultLayer),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [ApplicationTools.node, ExternalToolSource.node, ToolOutputStore.node],
})

export const toolsNode = makeLocationNode({
  service: Tools.Service,
  layer,
  deps: [ApplicationTools.node, ExternalToolSource.node, ToolOutputStore.node],
})
