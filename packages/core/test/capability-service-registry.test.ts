import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { CapabilityServiceRegistry } from "@novaclaw/core/capability-service-registry"
import { ConfigCapabilityService } from "@novaclaw/core/config/capability-service"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { it } from "./lib/effect"

type Declarations = Record<string, ConfigCapabilityService.Info>

const http = (capabilities: string[], disabled = false) =>
  new ConfigCapabilityService.Info({
    capabilities,
    transport: new ConfigCapabilityService.HttpTransport({
      type: "streamable-http",
      url: "http://127.0.0.1:9010/mcp",
      audience: "novaclaw-local",
    }),
    locality: "local",
    protocol_revision: "2025-06-18",
    resources: new ConfigCapabilityService.Resources({
      estimated_resident_bytes: 100,
      estimated_peak_bytes: 200,
    }),
    disabled,
  })

const settingsOf = (value: () => Declarations | undefined) =>
  Layer.succeed(
    SettingsConfigStore.Service,
    SettingsConfigStore.Service.of({
      all: () => Effect.sync(() => ({ capability_services: value() })),
      serverPassword: () => Effect.succeed(undefined),
      set: () => Effect.void,
      update: () => Effect.void,
      remove: () => Effect.void,
      unreadable: () => Effect.succeed([]),
      isEmpty: () => Effect.succeed(false),
    }),
  )

const registryIn = (settings: Layer.Layer<SettingsConfigStore.Service>) =>
  CapabilityServiceRegistry.layer.pipe(Layer.provide(settings))

describe("capability service declaration", () => {
  it.effect("closes transport variants and resource limits", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownSync(ConfigCapabilityService.Info)
      expect(
        decode({
          capabilities: ["document.parse.native"],
          transport: { type: "stdio", command: ["anydoc-mcp"], credential_env: ["ANYDOC_TOKEN"] },
          locality: "local",
          limits: { input_bytes: 1024 },
          resources: { estimated_resident_bytes: 100, estimated_peak_bytes: 200 },
        }).transport.type,
      ).toBe("stdio")
      expect(() =>
        decode({
          capabilities: ["document.parse.native"],
          transport: { type: "unknown", url: "http://example.test" },
          locality: "local",
          resources: { estimated_resident_bytes: 100, estimated_peak_bytes: 200 },
        }),
      ).toThrow()
      expect(() =>
        decode({
          capabilities: ["document.parse.native"],
          transport: { type: "streamable-http", url: "http://example.test" },
          locality: "local",
          resources: { estimated_resident_bytes: 100, estimated_peak_bytes: -1 },
        }),
      ).toThrow()
    }),
  )
})

describe("CapabilityServiceRegistry", () => {
  it.effect("indexes enabled candidates deterministically and keeps disabled entries inspectable", () =>
    Effect.gen(function* () {
      const registry = yield* CapabilityServiceRegistry.Service
      expect((yield* registry.inspect()).map((entry) => entry.id)).toEqual(["alpha", "zulu"])
      expect((yield* registry.candidates("document.parse.native")).map((entry) => entry.id)).toEqual(["alpha"])
      expect((yield* registry.get("zulu"))?.info.disabled).toBe(true)
    }).pipe(
      Effect.provide(
        registryIn(
          settingsOf(() => ({
            zulu: http(["document.parse.native"], true),
            alpha: http(["document.parse.native", "document.parse.layout"]),
          })),
        ),
      ),
    ),
  )

  it.effect("picks up a PATCH-shaped config replacement without a restart", () =>
    Effect.gen(function* () {
      let declarations: Declarations = { parser: http(["document.parse.native"]) }
      const registry = yield* Effect.provide(
        Effect.gen(function* () {
          return yield* CapabilityServiceRegistry.Service
        }),
        registryIn(settingsOf(() => declarations)),
      )
      expect((yield* registry.candidates("document.parse.layout")).length).toBe(0)
      declarations = { parser: http(["document.parse.native", "document.parse.layout"]) }
      expect((yield* registry.candidates("document.parse.layout")).map((entry) => entry.id)).toEqual(["parser"])
    }).pipe(Effect.scoped),
  )
})
