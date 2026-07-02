export * as PermissionV2 from "./permission"

import { makeLocationNode } from "./effect/app-node"
import { Context, Deferred, Effect as EffectRuntime, Layer, Schema } from "effect"
import { Permission } from "@novaclaw/schema/permission"
import { EventV2 } from "./event"
import { Location } from "./location"
import { AgentV2 } from "./agent"
import { SessionV2 } from "./session"
import { SessionStore } from "./session/store"
import { Wildcard } from "./util/wildcard"
import { EFFECTIVE_CONFIG_DEFAULTS, MODE_RULES, resolveSessionConfig, type PermissionMode } from "./session/config-resolve"
import { PermissionSaved } from "./permission/saved"

export { Effect, Rule, Ruleset } from "@novaclaw/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: AgentV2.ID.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionV2.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "PermissionV2.AskResult" })
export type AskResult = typeof AskResult.Type

export const Event = Permission.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionV2.RejectedError", {}) {}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionV2.CorrectedError", {
  feedback: Schema.String,
}) {}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionV2.DeniedError", {
  rules: Permission.Ruleset,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("PermissionV2.NotFoundError", {
  requestID: ID,
}) {}

export type Error = DeniedError | RejectedError | CorrectedError

/**
 * 1J: lower a permission failure into a model-legible message (denial as observation, never a
 * halt). Tools' blanket `mapError` absorbers call this FIRST, so a denial keeps its identity —
 * including the user's optional reject feedback — instead of collapsing into "Unable to <x>".
 */
export function denialMessage(error: unknown): string | undefined {
  if (error instanceof DeniedError) {
    const denied = error.rules.filter((rule) => rule.effect === "deny")
    const rules = denied.length ? denied : error.rules
    const actions = [...new Set(rules.map((rule) => rule.action))].join(", ") || "unknown"
    const resources = [...new Set(rules.map((rule) => rule.resource))].join(", ") || "unknown"
    return `Permission denied by policy: action '${actions}' on '${resources}' is not allowed in this mode. Do not retry the same call — work within permitted paths and actions, or ask the user to adjust permissions.`
  }
  if (error instanceof CorrectedError)
    return `The user declined this action and said: "${error.feedback}". Follow the user's direction instead of retrying the same call.`
  if (error instanceof RejectedError)
    return `The user declined permission for this action. Do not retry the identical call — take a different approach or ask the user how to proceed.`
  return undefined
}

export type ReplyVerdict = "allow" | "deny"
export type ReplyScope = "once" | "file" | "always"

/** 1K: normalize the six verdict-scope replies (+ the legacy trio) into {verdict, scope}. */
export function normalizeReply(reply: Reply): { verdict: ReplyVerdict; scope: ReplyScope } {
  switch (reply) {
    case "once":
    case "allow-once":
      return { verdict: "allow", scope: "once" }
    case "always":
    case "allow-always":
      return { verdict: "allow", scope: "always" }
    case "reject":
    case "deny-once":
      return { verdict: "deny", scope: "once" }
    case "allow-file":
      return { verdict: "allow", scope: "file" }
    case "deny-file":
      return { verdict: "deny", scope: "file" }
    case "deny-always":
      return { verdict: "deny", scope: "always" }
  }
}

/**
 * 1K: the resources a reply persists. `file` scope saves the request's CONCRETE resources (this
 * file only); `always` saves the request's broad `save` patterns; `once` persists nothing.
 */
export function savedResources(
  request: { readonly resources: readonly string[]; readonly save?: readonly string[] },
  scope: ReplyScope,
): readonly string[] {
  if (scope === "once") return []
  if (scope === "file") return request.resources
  return request.save ?? []
}

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

export interface Interface {
  readonly ask: (input: AssertInput) => EffectRuntime.Effect<AskResult, SessionV2.NotFoundError>
  readonly assert: (input: AssertInput) => EffectRuntime.Effect<void, Error | SessionV2.NotFoundError>
  readonly reply: (input: ReplyInput) => EffectRuntime.Effect<void, NotFoundError>
  readonly get: (id: ID) => EffectRuntime.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionV2.ID) => EffectRuntime.Effect<ReadonlyArray<Request>>
  readonly list: () => EffectRuntime.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: AgentV2.ID
  readonly deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
}

export const layer = Layer.effect(
  Service,
  EffectRuntime.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const agents = yield* AgentV2.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const pending = new Map<ID, Pending>()

    yield* EffectRuntime.addFinalizer(() =>
      EffectRuntime.forEach(pending.values(), (item) => Deferred.fail(item.deferred, new RejectedError()), {
        discard: true,
      }).pipe(
        EffectRuntime.ensuring(
          EffectRuntime.sync(() => {
            pending.clear()
          }),
        ),
      ),
    )

    const savedRules = EffectRuntime.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: item.effect ?? "allow" }),
      )
    })

    const configured = EffectRuntime.fn("PermissionV2.configured")(function* (
      sessionID: SessionV2.ID,
      agentID?: AgentV2.ID,
    ) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionV2.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      return agent?.permissions ?? missingAgentPermissions
    })

    function denied(input: AssertInput, rules: Permission.Ruleset) {
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const sessionMode = EffectRuntime.fnUntraced(function* (sessionID: SessionV2.ID) {
      const config = yield* resolveSessionConfig(EFFECTIVE_CONFIG_DEFAULTS, sessionID, (id) =>
        sessions.get(id as SessionV2.ID),
      )
      return config.permissionMode
    })

    const evaluateInput = EffectRuntime.fnUntraced(function* (input: AssertInput) {
      // 1K: the session's resolved permission MODE contributes a rule overlay. Appended after the
      // agent's configured rules (last-match-wins) so the user's explicit mode outranks agent
      // defaults; included in the early hard-deny check so a saved allow-always can never override
      // plan/surgical denies.
      const mode: PermissionMode = yield* sessionMode(input.sessionID).pipe(
        EffectRuntime.catch(() => EffectRuntime.succeed("ask" as const)),
      )
      const rules = [...(yield* configured(input.sessionID, input.agent)), ...MODE_RULES[mode]]
      if (denied(input, rules)) return { effect: "deny" as const, rules }
      const all = [...rules, ...(yield* savedRules())]
      const effects = input.resources.map((resource) => evaluate(input.action, resource, all).effect)
      const effect: Permission.Effect = effects.includes("deny") ? "deny" : effects.includes("ask") ? "ask" : "allow"
      return { effect, rules: all }
    })

    function request(input: AssertInput): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        metadata: input.metadata,
        source: input.source,
      }
    }

    const create = (request: Request, agent?: AgentV2.ID) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
          const item = { request, agent, deferred }
          if (pending.has(request.id)) return yield* EffectRuntime.die(`Duplicate pending permission ID: ${request.id}`)
          pending.set(request.id, item)
          yield* events
            .publish(Event.Asked, request)
            .pipe(EffectRuntime.onError(() => EffectRuntime.sync(() => pending.delete(request.id))))
          return item
        }),
      )

    const ask = EffectRuntime.fn("PermissionV2.ask")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      const value = request(input)
      if (result.effect === "ask") yield* create(value, input.agent)
      return { id: value.id, effect: result.effect }
    })

    const assert = EffectRuntime.fn("PermissionV2.assert")((input: AssertInput) =>
      EffectRuntime.uninterruptibleMask((restore) =>
        EffectRuntime.gen(function* () {
          const result = yield* evaluateInput(input)
          if (result.effect === "deny") {
            return yield* new DeniedError({
              rules: relevant(input, result.rules),
            })
          }
          if (result.effect === "allow") return
          const item = yield* create(request(input), input.agent)
          return yield* restore(Deferred.await(item.deferred)).pipe(
            EffectRuntime.ensuring(
              EffectRuntime.sync(() => {
                pending.delete(item.request.id)
              }),
            ),
          )
        }),
      ),
    )

    const reply = EffectRuntime.fn("PermissionV2.reply")((input: ReplyInput) =>
      EffectRuntime.uninterruptible(
        EffectRuntime.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          yield* events.publish(Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reply: input.reply,
          })

          const { verdict, scope } = normalizeReply(input.reply)
          const persisted = savedResources(existing.request, scope)

          if (verdict === "deny") {
            // 1K: a deny can persist (file/always scope) so the same ask never comes back.
            if (persisted.length)
              yield* saved.add({
                projectID: location.project.id,
                action: existing.request.action,
                resources: persisted,
                effect: "deny",
              })
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new RejectedError(),
            )
            pending.delete(input.requestID)
            for (const [id, item] of pending) {
              if (item.request.sessionID !== existing.request.sessionID) continue
              yield* events.publish(Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              })
              yield* Deferred.fail(item.deferred, new RejectedError())
              pending.delete(id)
            }
            return
          }

          if (persisted.length) {
            yield* saved.add({
              projectID: location.project.id,
              action: existing.request.action,
              resources: persisted,
              effect: "allow",
            })
          }
          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          if (!persisted.length) return

          const rememberedRules = yield* savedRules()
          for (const [id, item] of pending) {
            const input = { ...item.request }
            const rules = yield* configured(item.request.sessionID, item.agent).pipe(
              EffectRuntime.catchTag("Session.NotFoundError", () => EffectRuntime.succeed(undefined)),
            )
            if (!rules) continue
            if (denied(input, rules)) continue
            const effective = [...rules, ...rememberedRules]
            if (
              !item.request.resources.every(
                (resource) => evaluate(item.request.action, resource, effective).effect === "allow",
              )
            )
              continue
            yield* events.publish(Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "always",
            })
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
        }),
      ),
    )

    const list = EffectRuntime.fn("PermissionV2.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = EffectRuntime.fn("PermissionV2.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = EffectRuntime.fn("PermissionV2.forSession")(function* (sessionID: SessionV2.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ ask, assert, reply, get, forSession, list })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(AgentV2.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, Location.node, AgentV2.node, SessionStore.node, PermissionSaved.node],
})
