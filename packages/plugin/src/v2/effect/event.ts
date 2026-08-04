import type { Event as SDKEvent } from "@novaclaw/sdk/v2/types"
import type { Effect, Scope } from "effect"
import type { Registration } from "./registration.js"

/**
 * Every event type the instance publishes on its PUBLIC wire, keyed by discriminant.
 *
 * Derived from the generated SDK `Event` union — the same contract a client consuming
 * `/event` already sees — so a plugin is never coupled to the internal event payload
 * (which carries `data`, not `properties`, plus `durable`/`location`/`metadata` bookkeeping
 * that is nobody's business outside the kernel).
 *
 * ⚠️ Be honest about what this buys: most payloads in the union are
 * `properties: { [key: string]: unknown }`, because their internal schema is an open record.
 * So this map gives you **type names and a checked discriminant**, not deep field-level type
 * safety. Where a payload IS narrow (`session.created`, `integration.connection.updated`, …)
 * you get the real fields; everywhere else you must narrow `properties` yourself.
 */
export type EventMap = {
  [Item in SDKEvent as Item["type"]]: Item
}

/** The discriminant of every event a plugin may subscribe to. */
export type EventType = keyof EventMap

export interface EventHooks {
  /**
   * Observe every event of `type` for the lifetime of the plugin: unloading the plugin
   * (or disposing the registration) ends the subscription.
   *
   * The HOST owns the fork, the failure isolation and the teardown — a handler that fails,
   * throws or dies is logged and the subscription survives, and one plugin's bad handler
   * never starves another's. Delivery is buffered per subscription and DROPS (with a log)
   * once a handler falls far enough behind, so a slow plugin cannot grow the instance's
   * memory without bound.
   *
   * Scope of what arrives: events published at THIS plugin's location, plus instance-global
   * events that carry no location at all. Another location's traffic is never delivered.
   */
  readonly subscribe: <Type extends EventType>(
    type: Type,
    handler: (event: EventMap[Type]) => Effect.Effect<void>,
  ) => Effect.Effect<Registration, never, Scope.Scope>
}
