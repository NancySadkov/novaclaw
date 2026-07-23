import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { Messenger } from "@novaclaw/schema/messenger"
import { MessengerDrivers } from "@novaclaw/core/messenger/drivers"
import { ExternalDriverSource } from "@novaclaw/core/messenger/external-driver-source"
import type { Driver } from "@novaclaw/core/messenger/driver"
import { ConnectError } from "@novaclaw/core/messenger/driver"
import { it } from "./lib/effect"

// The §3.6 plugin-driver seam: MessengerDrivers composes `builtin ∪ ExternalDriverSource`, so an
// out-of-kernel plugin (WhatsApp/Baileys and future transports) contributes a driver WITHOUT core
// importing it. Empty default → builtin-only (no behavior change); built-ins win an id collision.

const CAPS: Messenger.Capabilities = {
  listChats: "none",
  files: { up: false, down: false },
  edits: false,
  typing: false,
  threads: false,
  moderation: { delete: false, ban: false, kick: false, mute: false, pin: false },
  format: "plain",
  maxChars: 1000,
}

const fakeDriver = (id: string): Driver => ({
  id,
  meta: { id, name: id, icon: "speech-bubble", auth: "key", settings: [], capabilities: CAPS },
  capabilities: () => CAPS,
  connect: () => Effect.fail(new ConnectError({ reason: "fake driver" })),
})

const registryWith = (drivers: readonly Driver[]) =>
  MessengerDrivers.layer.pipe(
    Layer.provide(Layer.succeed(ExternalDriverSource.Service, ExternalDriverSource.Service.of({ drivers: () => Effect.succeed(drivers) }))),
  )

describe("ExternalDriverSource → MessengerDrivers composition", () => {
  it.effect("empty source → builtin-only (email, gmail, discord, telegram present; no plugin driver)", () =>
    Effect.gen(function* () {
      const registry = yield* MessengerDrivers.Service
      const ids = registry.all().map((driver) => driver.id)
      expect(ids).toContain("email")
      expect(ids).toContain("email-gmail")
      expect(ids).toContain("discord")
      expect(ids).toContain("telegram")
      expect(registry.get("whatsapp")).toBeUndefined()
    }).pipe(Effect.provide(registryWith([]))),
  )

  it.effect("a plugin-contributed driver appears in all() and get()", () =>
    Effect.gen(function* () {
      const registry = yield* MessengerDrivers.Service
      expect(registry.get("whatsapp")?.id).toBe("whatsapp")
      expect(registry.all().some((driver) => driver.id === "whatsapp")).toBe(true)
      // Built-ins still present alongside the contributed one.
      expect(registry.get("email")?.id).toBe("email")
    }).pipe(Effect.provide(registryWith([fakeDriver("whatsapp")]))),
  )

  it.effect("built-ins win an id collision — a plugin cannot shadow a kernel transport", () =>
    Effect.gen(function* () {
      const registry = yield* MessengerDrivers.Service
      // The contributed "email" fake is auth:"key"; the real builtin email is auth:"login".
      expect(registry.get("email")?.meta.auth).toBe("login")
    }).pipe(Effect.provide(registryWith([fakeDriver("email")]))),
  )
})
