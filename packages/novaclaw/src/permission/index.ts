import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { ConfigPermission } from "@novaclaw/core/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@novaclaw/core/util/wildcard"
import { Deferred, Effect, Layer, Context } from "effect"
import os from "os"
import { PermissionRuleset } from "@novaclaw/schema/permission-ruleset"
import { Log } from "@novaclaw/schema/log"
import { normalizeReply } from "@novaclaw/core/permission"
import { EventV2Bridge } from "@/event-v2-bridge"

// `modeRuleset(mode)` — the V1-coarse permission-MODE overlay — was DELETED here (todo.md *"we
// discard all the cruft"*, v0.2.0-prep Wave 4 §5). It had zero production callers: V2 resolves a
// mode through `core/src/permission.ts`'s `MODE_RULES`, whose action vocabulary is finer than V1's
// (the comment it carried admitted `surgical` was inexpressible in it). Its only caller anywhere was
// the test that asserted its table back to it. The V1 `/permission` HTTP routes went in the same
// commit; what remains in this file is the ruleset algebra that IS still live —
// `evaluate` (skill filtering), `fromConfig`/`merge` (agent defaults).

export const Event = PermissionRuleset.Event

export interface Interface {
  readonly ask: (input: PermissionRuleset.AskInput) => Effect.Effect<void, PermissionRuleset.Error>
  readonly reply: (input: PermissionRuleset.ReplyInput) => Effect.Effect<void, PermissionRuleset.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionRuleset.Request>>
}

interface PendingEntry {
  info: PermissionRuleset.Request
  deferred: Deferred.Deferred<void, PermissionRuleset.RejectedError | PermissionRuleset.CorrectedError>
}

interface State {
  pending: Map<PermissionRuleset.ID, PendingEntry>
  approved: PermissionRuleset.Rule[]
}

export function evaluate(
  permission: string,
  pattern: string,
  ...rulesets: PermissionRuleset.Ruleset[]
): PermissionRuleset.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/Permission") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionRuleset.ID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionRuleset.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionRuleset.AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      let needsAsk = false

      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, approved)
        yield* Log.event("permission.rule.evaluate", {
          "permission.name": request.permission,
          "permission.pattern": pattern,
          "permission.action": rule.action,
        })
        if (rule.action === "deny") {
          return yield* new PermissionRuleset.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionRuleset.ID.ascending()
      const info: PermissionRuleset.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      yield* Log.event("permission.request.ask", {
        "permission.request.id": id,
        "permission.name": info.permission,
        "permission.patterns": JSON.stringify(info.patterns),
      })

      const deferred = yield* Deferred.make<void, PermissionRuleset.RejectedError | PermissionRuleset.CorrectedError>()
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionRuleset.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionRuleset.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      // 1K: the six verdict-scope replies (legacy trio aliased). `file` scope saves the request's
      // CONCRETE patterns; `always` saves the broad `always` patterns; `once` persists nothing.
      const { verdict, scope } = normalizeReply(input.reply)
      const persisted = scope === "file" ? existing.info.patterns : scope === "always" ? existing.info.always : []

      if (verdict === "deny") {
        // A deny can persist too, so the same ask never comes back (evaluate() is findLast —
        // a later deny rule overrides an earlier allow for the same pattern, and vice versa).
        for (const pattern of persisted) {
          approved.push({
            permission: existing.info.permission,
            pattern,
            action: "deny",
          })
        }
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionRuleset.CorrectedError({ feedback: input.message })
            : new PermissionRuleset.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionRuleset.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (persisted.length === 0) return

      for (const pattern of persisted) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermission.Info) {
  const ruleset: PermissionRuleset.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionRuleset.Ruleset[]): PermissionRuleset.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionRuleset.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export const defaultLayer = layer.pipe(Layer.provide(EventV2Bridge.defaultLayer))

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as Permission from "."
