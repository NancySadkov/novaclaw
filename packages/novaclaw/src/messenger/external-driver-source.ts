export * as NovaclawExternalDriverSource from "./external-driver-source"

import { Effect, Layer } from "effect"
import type { Driver } from "@novaclaw/core/messenger/driver"
import { WhatsAppBaileysDriver } from "@novaclaw/core/messenger/driver/whatsapp-baileys"
import { ExternalDriverSource } from "@novaclaw/core/messenger/external-driver-source"

// The novaclaw-side ExternalDriverSource (§3.6): contributes OUT-OF-KERNEL messenger drivers the
// instance opts into, replacing core's empty default at the messenger-services assembly. WhatsApp
// (the ToS-gray Baileys bridge) is gated behind NOVACLAW_ENABLE_WHATSAPP and its socket factory is
// DYNAMIC-imported only when enabled — so `@whiskeysockets/baileys` never loads at boot (or at all)
// when off. Enabling is deliberate (the user accepted the ban risk); the driver only opens a real
// socket at connect/login, not here.

const whatsappEnabled = () => (process.env.NOVACLAW_ENABLE_WHATSAPP ?? "").trim().length > 0

export const layer = Layer.effect(
  ExternalDriverSource.Service,
  Effect.gen(function* () {
    const drivers: Driver[] = []
    if (whatsappEnabled()) {
      // Loading the module evaluates the Baileys import; gated so that only happens on opt-in.
      const module = yield* Effect.promise(() => import("./whatsapp-baileys-socket"))
      drivers.push(WhatsAppBaileysDriver.make(module.factory))
      yield* Effect.logInfo("messenger: WhatsApp (Baileys) driver enabled")
    }
    return ExternalDriverSource.Service.of({ drivers: () => Effect.succeed(drivers) })
  }),
)
