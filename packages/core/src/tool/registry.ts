export * as ToolRegistry from "./registry"

import { ToolOutput, type ToolCall, type ToolDefinition, type ToolResultValue } from "@novaclaw/llm"
import { Context, Effect, Layer, Scope } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { ToolOutputStore } from "../tool-output-store"
import { Wildcard } from "../util/wildcard"
import { ApplicationTools } from "./application-tools"
import { ExternalToolSource } from "./external-tool-source"
import { definition, permission, settle, validateName, type AnyTool, type RegistrationError } from "./tool"
import { Tools } from "./tools"
import { makeLocationNode } from "../effect/app-node"

export type ExecuteInput = {
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
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

// A wrong tool name is a HORIZON failure, not a knowledge failure — the Juvenile Harness premise. A bare
// `Unknown tool: X` tells the model only that it lost; it names nothing to correct toward, so the model
// re-guesses (or gives up) and the turn is dead. Handing back the tools it actually has converts that into
// a recoverable turn. Same move, and deliberately the same tone, as the textual-call steer in
// session/runner/textual-call.ts: name the mistake, say plainly that nothing ran, give the exact
// correction, and close the "write the call as text instead" escape hatch.
//
// Ported from github.com/NancySadkov/novaclaw PR #4 (@DassaultFalconKing).

/**
 * Characters of tool names the message may spend before it truncates. The full built-in set is 28 short
 * names (~250 characters), so this never bites on a stock session — it exists only because MCP servers and
 * plugins register unboundedly many, and a 6 KB error would evict the very context the model needs. A
 * count cap would be the wrong unit: 12 of 28 names hides `read` from a model that just called `read_file`.
 */
export const UNKNOWN_TOOL_LIST_BUDGET = 800

/**
 * Case, separators and word breaks are the near-misses a model actually produces — and our own names mix
 * both separators (`read-hex`, `register-app` next to `apply_patch`, `tool_manual`), so `read_hex` is a
 * near-certain miss. Comparing on alphanumerics alone catches every one of those exactly.
 */
const canonical = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "")

/** Exact-after-normalization beats "the model added a suffix" beats "the model truncated"; inside a tier
 * the longer shared prefix is the more specific match. `0` means not close at all. */
const rank = (target: string, key: string) => {
  if (key === target) return 3_000 + key.length
  if (target.startsWith(key)) return 2_000 + key.length
  if (key.startsWith(target)) return 1_000 + target.length
  return 0
}

/**
 * The one tool the caller most plausibly meant, or `undefined` when nothing is close — or when two
 * candidates are equally close. Never guess on a tie: `web` between `webfetch` and `websearch` is a coin
 * flip, and a confidently wrong "did you mean" costs more than no hint at all.
 */
export const closestToolName = (name: string, available: Iterable<string>): string | undefined => {
  const target = canonical(name)
  if (target.length < 2) return undefined
  let best: string | undefined
  let score = 0
  let tied = false
  for (const candidate of available) {
    const key = canonical(candidate)
    if (key.length < 2) continue
    const current = rank(target, key)
    if (current === 0 || current < score) continue
    if (current === score) {
      if (candidate !== best) tied = true
      continue
    }
    score = current
    best = candidate
    tied = false
  }
  return tied ? undefined : best
}

/**
 * The tool-result error for a name that was never advertised. `available` is the advertised set, in
 * advertised order: the message re-states the very list the model was given rather than inventing a
 * second, differently sorted one (sorting would make the error and the tool list disagree for no gain).
 */
export const unknownToolMessage = (name: string, available: Iterable<string>): string => {
  const names = Array.from(available)
  if (names.length === 0)
    return (
      `Unknown tool: ${name}. Nothing ran — no tools are available in this turn. Do not invent a tool or ` +
      `write a call as text; answer in your reply instead.`
    )
  // The near-miss is carried in its own clause, never only inside the list, so truncation can never hide
  // the one name that would have fixed the call.
  const hint = closestToolName(name, names)
  const shown: Array<string> = []
  let budget = UNKNOWN_TOOL_LIST_BUDGET
  for (const candidate of names) {
    budget -= candidate.length + 2
    if (budget < 0 && shown.length > 0) break
    shown.push(candidate)
  }
  const listed =
    shown.length === names.length
      ? `Available tools: ${shown.join(", ")}.`
      : `Available tools (${shown.length} of ${names.length}): ${shown.join(", ")}, and ${names.length - shown.length} more.`
  return (
    `Unknown tool: ${name}. Nothing ran. ${hint ? `Did you mean "${hint}"? ` : ""}${listed} ` +
    `Use one of these exact advertised names — do not invent a tool or write a call as text.`
  )
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
    // caller resolves the registration first and reports an unadvertised name itself (`unknownToolMessage`).
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
        yield* Effect.forEach(entries, ([name]) => validateName(name), { discard: true })
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
        for (const [name, registration] of registrations)
          if (whollyDisabled(permission(registration.tool, name), permissions)) registrations.delete(name)
        return {
          definitions: Array.from(registrations, ([name, registration]) => definition(name, registration.tool)),
          settle: (input) => {
            const registration = registrations.get(input.call.name)
            if (registration) return settleWith(input, registration.identity)
            // `registrations` IS the advertised set — `definitions` above is built from it — so the model is
            // handed back exactly the horizon it was given, in the same order.
            return Effect.succeed({
              result: { type: "error", value: unknownToolMessage(input.call.name, registrations.keys()) },
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
