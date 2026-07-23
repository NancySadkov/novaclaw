export * as MessengerDrivers from "./drivers"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import type { Driver } from "./driver"
import { ExternalDriverSource } from "./external-driver-source"
import { DiscordDriver } from "./driver/discord"
import { EmailDriver } from "./driver/email"
import { EmailGmailDriver } from "./driver/email-gmail"
import { EmailImapSmtp } from "./driver/email-imap-smtp"
import { EmailOAuth } from "./driver/email-oauth"
import { EmailOAuthGoogle } from "./driver/email-oauth-google"
import { IrcDriver } from "./driver/irc"
import { OAuthLoopback } from "./oauth-loopback"
import { RedditDriver } from "./driver/reddit"
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
// live-gated factory files) and its Gmail sibling (the friendly "Sign in with Google" auth-code +
// loopback browser flow — reuses the email connection pump, swaps only the auth: Google client +
// loopback catcher factories); P12 adds Reddit — a SUBREDDIT is the chat you bind and every post
// is a thread under it, so one binding moderates a live community (the parent-routing shape).
// Tests mock this service with fakes; a future ExternalDriverSource seam
// (plugin-contributed drivers) would compose here, exactly like ExternalToolSource does for tools.

const builtin: readonly Driver[] = [
  TelegramUserDriver.make(TelegramUserMtcute.factory),
  EmailDriver.make(EmailImapSmtp.factory, EmailOAuth.factory),
  EmailGmailDriver.make(EmailImapSmtp.factory, EmailOAuthGoogle.factory, OAuthLoopback.startLoopback, OAuthLoopback.openBrowser),
  TelegramDriver.driver,
  DiscordDriver.driver,
  IrcDriver.driver,
  RedditDriver.make((url, init) => fetch(url, init), OAuthLoopback.startLoopback, OAuthLoopback.openBrowser),
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

// builtin ∪ external (plugin-contributed, §3.6). The external set is snapshotted when this layer
// builds (plugins load first); built-ins come first, so a contributed driver can never shadow a
// kernel transport (get() returns the first id match). Default empty source → builtin-only, no
// behavior change until a plugin registers a driver.
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const external = yield* ExternalDriverSource.Service
    const contributed = yield* external.drivers()
    return make([...builtin, ...contributed])
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [ExternalDriverSource.node] })
