export * as MessengerDrivers from "./drivers"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import type { Driver } from "./driver"

// The static driver registry (notes/messenger-plan.md §1.5): one entry per platform — throwing a
// messenger in or out on demand IS editing this list. P0 ships the contract with no drivers
// (telegram lands in P1; discord/irc in P7; email in P9). Tests mock this service with fakes;
// a future ExternalDriverSource seam (plugin-contributed drivers) would compose here, exactly
// like ExternalToolSource does for tools.

const builtin: readonly Driver[] = []

export interface Interface {
  readonly all: () => readonly Driver[]
  readonly get: (id: string) => Driver | undefined
}

export const make = (drivers: readonly Driver[]): Interface => ({
  all: () => drivers,
  get: (id) => drivers.find((driver) => driver.id === id),
})

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/MessengerDrivers") {}

export const layer = Layer.succeed(Service, Service.of(make(builtin)))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
