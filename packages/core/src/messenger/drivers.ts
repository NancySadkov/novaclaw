export * as MessengerDrivers from "./drivers"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import type { Driver } from "./driver"
import { TelegramDriver } from "./driver/telegram"
import { TelegramUserDriver } from "./driver/telegram-user"
import { TelegramUserMtcute } from "./driver/telegram-user-mtcute"

// The static driver registry (notes/messenger-plan.md §1.5): one entry per platform — throwing a
// messenger in or out on demand IS editing this list. P1 shipped the Telegram bot driver (the
// zero-dep, fake-testable path); P1.7 adds the PRODUCTION Telegram user-account driver (MTProto
// via mtcute — the §2.2 owner decision; loaded lazily, never at boot); discord/irc land in P7,
// email in P9. Tests mock this service with fakes; a future ExternalDriverSource seam
// (plugin-contributed drivers) would compose here, exactly like ExternalToolSource does for tools.

const builtin: readonly Driver[] = [TelegramUserDriver.make(TelegramUserMtcute.factory), TelegramDriver.driver]

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
