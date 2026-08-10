import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { CapabilityServiceRegistry } from "@novaclaw/core/capability-service-registry"
import { Config } from "@novaclaw/core/config"
import { ConfigCapabilityService } from "@novaclaw/core/config/capability-service"
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

const configOf = (value: () => Declarations | undefined) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.sync(() => {
          const current = value()
          return current === undefined
            ? []
            : [new Config.Document({ type: "document", info: new Config.Info({ capability_services: current }) })]
        }),
    }),
  )

const registryIn = (config: Layer.Layer<Config.Service>) => CapabilityServiceRegistry.layer.pipe(Layer.provide(config))

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
        }).transport.type,
      ).toBe("stdio")
      expect(() =>
        decode({
          capabilities: ["document.parse.native"],
          transport: { type: "unknown", url: "http://example.test" },
          locality: "local",
        }),
      ).toThrow()
      expect(() =>
        decode({
          capabilities: ["document.parse.native"],
          transport: { type: "streamable-http", url: "http://example.test" },
          locality: "local",
          resources: { estimated_peak_bytes: -1 },
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
          configOf(() => ({
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
        registryIn(configOf(() => declarations)),
      )
      expect((yield* registry.candidates("document.parse.layout")).length).toBe(0)
      declarations = { parser: http(["document.parse.native", "document.parse.layout"]) }
      expect((yield* registry.candidates("document.parse.layout")).map((entry) => entry.id)).toEqual(["parser"])
    }).pipe(Effect.scoped),
  )
})
