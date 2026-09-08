import { describe, expect, test } from "bun:test"
import { CapabilityServiceRegistry } from "@novaclaw/core/capability-service-registry"
import { CapabilityServiceRuntime } from "@novaclaw/core/capability-service-runtime"
import { ConfigCapabilityService } from "@novaclaw/core/config/capability-service"
import { Global } from "@novaclaw/core/global"
import { ResourcePressureContext } from "@novaclaw/core/resource-pressure-context"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Layer } from "effect"
import { fileURLToPath } from "node:url"
import { McpCapabilityServiceWorker } from "@/mcp/capability-service-worker"
import { McpAuth } from "@/mcp/auth"

const graph = (fixture: string) => {
  const info = new ConfigCapabilityService.Info({
    capabilities: ["document.parse.native"],
    transport: new ConfigCapabilityService.StdioTransport({
      type: "stdio",
      command: [process.execPath, fixture],
    }),
    locality: "local",
    protocol_revision: LATEST_PROTOCOL_VERSION,
    resources: new ConfigCapabilityService.Resources({
      estimated_resident_bytes: 1,
      estimated_peak_bytes: 1,
    }),
  })
  const settings = Layer.succeed(
    SettingsConfigStore.Service,
    SettingsConfigStore.Service.of({
      all: () => Effect.succeed({ capability_services: { parser: info } }),
      serverPassword: () => Effect.succeed(undefined),
      set: () => Effect.void,
      update: () => Effect.void,
      remove: () => Effect.void,
      unreadable: () => Effect.succeed([]),
      isEmpty: () => Effect.succeed(false),
    }),
  )
  const registry = CapabilityServiceRegistry.layer.pipe(Layer.provide(settings))
  const pressure = Layer.succeed(
    ResourcePressureContext.Service,
    ResourcePressureContext.Service.of({
      inspect: () => Effect.succeed([]),
      capacity: () => Effect.succeed({ limitBytes: 1_000, usedBytes: 100, floorUsedFraction: 0.8 }),
      level: () => Effect.succeed("ok"),
    }),
  )
  const auth = Layer.succeed(
    McpAuth.Service,
    McpAuth.Service.of({
      all: () => Effect.succeed({}),
      get: () => Effect.succeed(undefined),
      getForUrl: () => Effect.succeed(undefined),
      set: () => Effect.void,
      remove: () => Effect.void,
      updateTokens: () => Effect.void,
      updateClientInfo: () => Effect.void,
      updateCodeVerifier: () => Effect.void,
      clearCodeVerifier: () => Effect.void,
      updateOAuthState: () => Effect.void,
      getOAuthState: () => Effect.succeed(undefined),
      clearOAuthState: () => Effect.void,
    }),
  )
  const worker = McpCapabilityServiceWorker.layer.pipe(
    Layer.provide(auth),
    Layer.provide(Global.layerWith({ data: process.cwd(), config: process.cwd() })),
  )
  return CapabilityServiceRuntime.layer.pipe(Layer.provide(registry), Layer.provide(pressure), Layer.provide(worker))
}

describe("capability service crash recovery", () => {
  test("an actual stdio crash fails once, parks the service, and restarts cleanly after retry", async () => {
    const fixture = fileURLToPath(new URL("../fixture/mcp-capability-stdio.ts", import.meta.url))

    await Effect.runPromise(
      Effect.gen(function* () {
        const runtime = yield* CapabilityServiceRuntime.Service
        const crashed = yield* Effect.exit(
          runtime.execute({
            serviceID: "parser",
            requestID: "crash-once",
            capability: "document.parse.native",
            arguments: { crash: true },
          }),
        )
        expect(crashed._tag).toBe("Failure")
        expect((yield* runtime.snapshot())[0]?.phase).toBe("unavailable")

        expect(yield* runtime.retry("parser")).toBe(true)
        expect(
          yield* runtime.execute({
            serviceID: "parser",
            requestID: "after-restart",
            capability: "document.parse.native",
            arguments: { handle: "file:recovered" },
          }),
        ).toMatchObject({ content: [{ type: "text", text: "file:recovered" }] })
        expect((yield* runtime.snapshot())[0]?.phase).toBe("ready")
      }).pipe(Effect.provide(graph(fixture)), Effect.scoped),
    )
  })
})
