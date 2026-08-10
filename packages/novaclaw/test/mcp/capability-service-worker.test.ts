import { afterEach, describe, expect, test } from "bun:test"
import { CapabilityServiceWorker } from "@novaclaw/core/capability-service-worker"
import { ConfigCapabilityService } from "@novaclaw/core/config/capability-service"
import { Global } from "@novaclaw/core/global"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Layer } from "effect"
import { McpCapabilityServiceWorker } from "@/mcp/capability-service-worker"

const servers: Bun.Server<unknown>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

describe("McpCapabilityServiceWorker", () => {
  test("connects, invokes only declared tools, checks health, and closes the transport", async () => {
    const methods: string[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method === "GET") return new Response(null, { status: 405 })
        if (request.method === "DELETE") return new Response(null, { status: 200 })
        const message = (await request.json()) as { id?: number; method: string; params?: unknown }
        methods.push(message.method)
        if (message.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "capability-fixture", version: "1" },
            },
          })
        if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
        if (message.method === "tools/call")
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: "parsed" }] },
          })
        return Response.json({ jsonrpc: "2.0", id: message.id, result: {} })
      },
    })
    servers.push(server)

    const info = new ConfigCapabilityService.Info({
      capabilities: ["document.parse.native"],
      transport: new ConfigCapabilityService.HttpTransport({
        type: "streamable-http",
        url: server.url.toString(),
      }),
      locality: "local",
      resources: new ConfigCapabilityService.Resources({
        estimated_resident_bytes: 1,
        estimated_peak_bytes: 1,
      }),
    })
    const global = Global.layerWith({ data: process.cwd(), config: process.cwd() })
    const layer = McpCapabilityServiceWorker.layer.pipe(Layer.provide(global))

    await Effect.runPromise(
      Effect.gen(function* () {
        const worker = yield* CapabilityServiceWorker.Service
        yield* worker.start("parser", info)
        expect(
          yield* worker.run({
            serviceID: "parser",
            capability: "document.parse.native",
            arguments: { handle: "file:1" },
          }),
        ).toMatchObject({ content: [{ type: "text", text: "parsed" }] })
        expect(yield* worker.health("parser", 1_000)).toBe(true)
        expect(
          yield* Effect.flip(
            worker.run({ serviceID: "parser", capability: "undeclared", arguments: {} }),
          ),
        ).toBeInstanceOf(Error)
        yield* worker.stop("parser")
        expect(yield* worker.health("parser")).toBe(false)
      }).pipe(Effect.provide(layer)),
    )

    expect(methods).toContain("initialize")
    expect(methods).toContain("tools/call")
    expect(methods).toContain("ping")
  })

  test("fails closed instead of sending an audience-bound HTTP request without a broker", async () => {
    const info = new ConfigCapabilityService.Info({
      capabilities: ["document.parse.native"],
      transport: new ConfigCapabilityService.HttpTransport({
        type: "streamable-http",
        url: "http://127.0.0.1:1/mcp",
        audience: "parser",
      }),
      locality: "local",
      resources: new ConfigCapabilityService.Resources({
        estimated_resident_bytes: 1,
        estimated_peak_bytes: 1,
      }),
    })
    const layer = McpCapabilityServiceWorker.layer.pipe(Layer.provide(Global.layerWith({ data: process.cwd() })))
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const worker = yield* CapabilityServiceWorker.Service
        return yield* Effect.flip(worker.start("parser", info))
      }).pipe(Effect.provide(layer)),
    )
    expect(error.message).toContain("audience-bound authorization")
  })
})
