export * as MessengerDrivers from "./drivers"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import type { Driver } from "./driver"
import { DiscordDriver } from "./driver/discord"
import { EmailDriver } from "./driver/email"
import { EmailImapSmtp } from "./driver/email-imap-smtp"
import { EmailOAuth } from "./driver/email-oauth"
import { IrcDriver } from "./driver/irc"
import { TelegramDriver } from "./driver/telegram"
import { TelegramUserDriver } from "./driver/telegram-user"
import { TelegramUserMtcute } from "./driver/telegram-user-mtcute"

// The static driver registry (notes/messenger-plan.md §1.5): one entry per platform — throwing a
// messenger in or out on demand IS editing this list. P1 shipped the Telegram bot driver (the
// zero-dep, fake-testable path); P1.7 adds the PRODUCTION Telegram user-account driver (MTProto
// via mtcute — the §2.2 owner decision; loaded lazily, never at boot); P7 adds Discord (gateway
// WS + REST behind seams) and IRC (the degradation floor: raw TCP/TLS, byte-budgeted lines, no
// files); P9 adds email (the user's own mailbox — IMAP poll + SMTP send behind a transport seam,
// OAuth2 device-code login since Microsoft killed Basic Auth; the raw wire + Microsoft HTTP are the
// live-gated factory files). Tests mock this service with fakes; a future ExternalDriverSource seam
// (plugin-contributed drivers) would compose here, exactly like ExternalToolSource does for tools.

const builtin: readonly Driver[] = [
  TelegramUserDriver.make(TelegramUserMtcute.factory),
  EmailDriver.make(EmailImapSmtp.factory, EmailOAuth.factory),
  TelegramDriver.driver,
  DiscordDriver.driver,
  IrcDriver.driver,
]

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
