export * as ToolRegistry from "./registry"

import { ToolOutput, ToolRuntime, type ToolCall, type ToolDefinition, type ToolResultValue } from "@novaclaw/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { ExternalToolSource } from "./external-tool-source"
import { definition, permission, settle, validateRegistration, type AnyTool, type RegistrationError } from "./tool"
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
  readonly materialize: (permissions?: PermissionV2.Ruleset) => Effect.Effect<Materialization>
  /** Internal registration capability exposed publicly only through Tools.Service. */
  readonly register: (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>
}

export interface Materialization {
  readonly definitions: ReadonlyArray<ToolDefinition>
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

/**
 * Declare a live availability predicate for a tool: `materialize` evaluates it when the model's
 * horizon is built, and withdraws the tool for that horizon when it answers `false`.
 *
 * ⚠️ **This is the SECOND horizon filter, and it is deliberately generic — the registry must never
 * learn a tool's name.** The first is `whollyDisabled` below, which withdraws a tool the permission
 * ruleset wholly denies. This one withdraws a tool whose OWN module says it is unavailable right
 * now, and the reason it exists is todo.md **ruling 3** (*read every runtime-editable value through
 * to its store at the point of use; a settings change is not a reboot*): a tool that decides its
 * availability from config cannot decide it once, at `Layer.effect` scope, because that answer is
 * frozen until the whole location is torn down. `tool/profile.ts` is the only such tool in the tree
 * and carries the full design argument, including the two options that were rejected.
 *
 * Both filters answer the same question — *is this tool on the horizon* — and they answer it in one
 * place, which is what ruling 6 asks for. Neither advertises-then-refuses: a withdrawn tool is
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

    // `advertised` is the identity materialization handed to the model, and it is always supplied: the only
    // caller resolves the registration first and reports an unadvertised name itself
    // (`ToolRuntime.unknownToolMessage`).
    // Reaching here with no registration therefore means it was removed mid-turn — stale, never unknown.
    const settleWith = Effect.fn("ToolRegistry.settle")(function* (input: ExecuteInput, advertised: object) {
      const registration =
        local.get(input.call.name)?.at(-1)?.registration ??
        applications.entries().get(input.call.name) ??
        (yield* external.entries()).get(input.call.name)
      if (!registration) return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      if (registration.identity !== advertised)
        return { result: { type: "error" as const, value: `Stale tool call: ${input.call.name}` } }
      const pending = yield* settle(registration.tool, input.call, {
        sessionID: input.sessionID,
        agent: input.agent,
        assistantMessageID: input.assistantMessageID,
        toolCallID: input.call.id,
        attachmentPaths: input.attachmentPaths ?? new Set(),
      }).pipe(
        Effect.map((output) => ({ output })),
        Effect.catchTag("LLM.ToolFailure", (failure) =>
          Effect.succeed({ result: { type: "error" as const, value: failure.message } }),
        ),
      )
      if ("result" in pending) return pending
      const output = pending.output
      const bounded = yield* resources.bound({ sessionID: input.sessionID, toolCallID: input.call.id, output })
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
      materialize: Effect.fn("ToolRegistry.materialize")(function* (permissions = []) {
        const registrations = new Map(applications.entries())
        for (const [name, entry] of yield* external.entries()) registrations.set(name, entry)
        for (const [name, entries] of local) {
          const registration = entries.at(-1)?.registration
          if (registration) registrations.set(name, registration)
        }
        // Two withdrawals, one seam. The permission ruleset decides first because it is free and
        // because a wholly-denied tool must not get to run an Effect to decide it is available.
        for (const [name, registration] of registrations) {
          if (whollyDisabled(permission(registration.tool, name), permissions)) {
            registrations.delete(name)
            continue
          }
          const available = availabilityOf.get(registration.tool)
          if (available !== undefined && !(yield* available)) registrations.delete(name)
        }
        return {
          definitions: Array.from(registrations, ([name, registration]) => definition(name, registration.tool)),
          settle: (input) => {
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration.identity)
            // `registrations` IS the advertised set — `definitions` above is built from it — so the model is
            // handed back exactly the horizon it was given, in the same order.
            return Effect.succeed({
              result: { type: "error", value: ToolRuntime.unknownToolMessage(input.call.name, registrations.keys()) },
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
