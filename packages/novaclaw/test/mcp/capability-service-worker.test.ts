import { afterEach, describe, expect, test } from "bun:test"
import { CapabilityServiceWorker } from "@novaclaw/core/capability-service-worker"
import { ConfigCapabilityService } from "@novaclaw/core/config/capability-service"
import { Global } from "@novaclaw/core/global"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Layer } from "effect"
import { fileURLToPath } from "node:url"
import { McpCapabilityServiceWorker } from "@/mcp/capability-service-worker"
import { McpAuth } from "@/mcp/auth"

const servers: Bun.Server<unknown>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

const authLayer = (lookup?: (audience: string, url: string) => McpAuth.Entry | undefined) =>
  Layer.succeed(
    McpAuth.Service,
    McpAuth.Service.of({
      all: () => Effect.succeed({}),
      get: () => Effect.succeed(undefined),
      getForUrl: (audience, url) => Effect.succeed(lookup?.(audience, url)),
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

const workerLayer = (auth = authLayer()) => McpCapabilityServiceWorker.layer.pipe(Layer.provide(auth))

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
        if (message.method === "tools/list")
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [
                {
                  name: "document.parse.native",
                  inputSchema: {
                    type: "object",
                    properties: { handle: { type: "string" } },
                    required: ["handle"],
                  },
                },
              ],
            },
          })
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
      protocol_revision: LATEST_PROTOCOL_VERSION,
      resources: new ConfigCapabilityService.Resources({
        estimated_resident_bytes: 1,
        estimated_peak_bytes: 1,
      }),
    })
    const global = Global.layerWith({ data: process.cwd(), config: process.cwd() })
    const layer = workerLayer().pipe(Layer.provide(global))

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
    expect(methods).toContain("tools/list")
    expect(methods).toContain("tools/call")
    expect(methods).toContain("ping")
  })

  test("negotiates and validates a real stdio service before invoking it", async () => {
    const fixture = fileURLToPath(new URL("../fixture/mcp-capability-stdio.ts", import.meta.url))
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
    const layer = workerLayer().pipe(
      Layer.provide(Global.layerWith({ data: process.cwd(), config: process.cwd() })),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const worker = yield* CapabilityServiceWorker.Service
        yield* worker.start("stdio-parser", info)
        return yield* worker.run({
          serviceID: "stdio-parser",
          capability: "document.parse.native",
          arguments: { handle: "file:stdio" },
        })
      }).pipe(Effect.provide(layer), Effect.scoped),
    )

    expect(result).toMatchObject({ content: [{ type: "text", text: "file:stdio" }] })
  })

  test("reconnects a live service when its runtime declaration changes", async () => {
    const initialized: string[] = []
    const serve = (name: string) => {
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          if (request.method === "GET") return new Response(null, { status: 405 })
          if (request.method === "DELETE") {
            return new Response(null, { status: 200 })
          }
          const message = (await request.json()) as { id?: number; method: string }
          if (message.method === "initialize") {
            initialized.push(name)
            return Response.json(
              {
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: LATEST_PROTOCOL_VERSION,
                  capabilities: { tools: {} },
                  serverInfo: { name, version: "1" },
                },
              },
              { headers: { "Mcp-Session-Id": name } },
            )
          }
          if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
          if (message.method === "tools/list")
            return Response.json({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                tools: [{ name: "document.parse.native", inputSchema: { type: "object", properties: {} } }],
              },
            })
          if (message.method === "tools/call")
            return Response.json({
              jsonrpc: "2.0",
              id: message.id,
              result: { content: [{ type: "text", text: name }] },
            })
          return Response.json({ jsonrpc: "2.0", id: message.id, result: {} })
        },
      })
      servers.push(server)
      return server
    }
    const first = serve("first")
    const second = serve("second")
    const declaration = (url: string) =>
      new ConfigCapabilityService.Info({
        capabilities: ["document.parse.native"],
        transport: new ConfigCapabilityService.HttpTransport({ type: "streamable-http", url }),
        locality: "local",
        protocol_revision: LATEST_PROTOCOL_VERSION,
        resources: new ConfigCapabilityService.Resources({
          estimated_resident_bytes: 1,
          estimated_peak_bytes: 1,
        }),
      })
    const firstInfo = declaration(first.url.toString())
    const secondInfo = declaration(second.url.toString())
    const layer = workerLayer().pipe(
      Layer.provide(Global.layerWith({ data: process.cwd(), config: process.cwd() })),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const worker = yield* CapabilityServiceWorker.Service
        yield* worker.start("parser", firstInfo)
        yield* worker.start("parser", firstInfo)
        yield* worker.start("parser", secondInfo)
        return yield* worker.run({
          serviceID: "parser",
          capability: "document.parse.native",
          arguments: {},
        })
      }).pipe(Effect.provide(layer), Effect.scoped),
    )

    expect(result).toMatchObject({ content: [{ type: "text", text: "second" }] })
    expect(initialized).toEqual(["first", "second"])
  })

  test("rejects protocol and declared-tool contract mismatches before becoming live", async () => {
    const serve = (revision: string, tools: ReadonlyArray<Record<string, unknown>>) => {
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          if (request.method === "GET") return new Response(null, { status: 405 })
          if (request.method === "DELETE") return new Response(null, { status: 200 })
          const message = (await request.json()) as { id?: number; method: string }
          if (message.method === "initialize")
            return Response.json({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: revision,
                capabilities: { tools: {} },
                serverInfo: { name: "contract-fixture", version: "1" },
              },
            })
          if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
          if (message.method === "tools/list")
            return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools } })
          return Response.json({ jsonrpc: "2.0", id: message.id, result: {} })
        },
      })
      servers.push(server)
      return server
    }
    const declaration = (url: string, protocolRevision: string) =>
      new ConfigCapabilityService.Info({
        capabilities: ["document.parse.native"],
        transport: new ConfigCapabilityService.HttpTransport({ type: "streamable-http", url }),
        locality: "local",
        protocol_revision: protocolRevision,
        resources: new ConfigCapabilityService.Resources({
          estimated_resident_bytes: 1,
          estimated_peak_bytes: 1,
        }),
      })
    const validTool = {
      name: "other.tool",
      inputSchema: { type: "object", properties: {} },
    }

    const wrongRevision = serve(LATEST_PROTOCOL_VERSION, [validTool])
    const revisionError = await Effect.runPromise(
      Effect.gen(function* () {
        const worker = yield* CapabilityServiceWorker.Service
        return yield* Effect.flip(worker.start("revision", declaration(wrongRevision.url.toString(), "1900-01-01")))
      }).pipe(
        Effect.provide(workerLayer()),
        Effect.provide(Global.layerWith({ data: process.cwd(), config: process.cwd() })),
        Effect.scoped,
      ),
    )
    expect(revisionError.message).toContain("config requires 1900-01-01")

    const missingTool = serve(LATEST_PROTOCOL_VERSION, [validTool])
    const schemaError = await Effect.runPromise(
      Effect.gen(function* () {
        const worker = yield* CapabilityServiceWorker.Service
        return yield* Effect.flip(
          worker.start("schema", declaration(missingTool.url.toString(), LATEST_PROTOCOL_VERSION)),
        )
      }).pipe(
        Effect.provide(workerLayer()),
        Effect.provide(Global.layerWith({ data: process.cwd(), config: process.cwd() })),
        Effect.scoped,
      ),
    )
    expect(schemaError.message).toContain("does not expose declared tool: document.parse.native")

    const malformedSchema = serve(LATEST_PROTOCOL_VERSION, [
      { name: "document.parse.native", inputSchema: { type: "string" } },
    ])
    const schemaShapeError = await Effect.runPromise(
      Effect.gen(function* () {
        const worker = yield* CapabilityServiceWorker.Service
        return yield* Effect.flip(
          worker.start("schema-shape", declaration(malformedSchema.url.toString(), LATEST_PROTOCOL_VERSION)),
        )
      }).pipe(
        Effect.provide(workerLayer()),
        Effect.provide(Global.layerWith({ data: process.cwd(), config: process.cwd() })),
        Effect.scoped,
      ),
    )
    expect(schemaShapeError.message).toContain('"inputSchema"')
  })

  test("brokers an audience-bound token only for its exact service URL", async () => {
    const authorizations: Array<string | null> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method === "GET") return new Response(null, { status: 405 })
        if (request.method === "DELETE") return new Response(null, { status: 200 })
        authorizations.push(request.headers.get("authorization"))
        const message = (await request.json()) as { id?: number; method: string }
        if (message.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "authorized-fixture", version: "1" },
            },
          })
        if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
        if (message.method === "tools/list")
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [{ name: "document.parse.native", inputSchema: { type: "object", properties: {} } }],
            },
          })
        if (message.method === "tools/call")
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: "authorized" }] },
          })
        return Response.json({ jsonrpc: "2.0", id: message.id, result: {} })
      },
    })
    servers.push(server)
    const lookups: Array<readonly [string, string]> = []
    const auth = authLayer((audience, url) => {
      lookups.push([audience, url])
      return url === server.url.toString()
        ? { tokens: { accessToken: "service-secret" }, serverUrl: url }
        : undefined
    })
    const info = new ConfigCapabilityService.Info({
      capabilities: ["document.parse.native"],
      transport: new ConfigCapabilityService.HttpTransport({
        type: "streamable-http",
        url: server.url.toString(),
        audience: "native-documents",
      }),
      locality: "lan",
      resources: new ConfigCapabilityService.Resources({
        estimated_resident_bytes: 1,
        estimated_peak_bytes: 1,
      }),
    })
    const layer = workerLayer(auth).pipe(
      Layer.provide(Global.layerWith({ data: process.cwd(), config: process.cwd() })),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const worker = yield* CapabilityServiceWorker.Service
        yield* worker.start("authorized", info)
        return yield* worker.run({
          serviceID: "authorized",
          capability: "document.parse.native",
          arguments: {},
        })
      }).pipe(Effect.provide(layer), Effect.scoped),
    )

    expect(result).toMatchObject({ content: [{ type: "text", text: "authorized" }] })
    expect(lookups).toEqual([["native-documents", server.url.toString()]])
    expect(authorizations.length).toBeGreaterThan(0)
    expect(authorizations.every((value) => value === "Bearer service-secret")).toBe(true)
  })

  test("never follows a redirect with an audience-bound token", async () => {
    let sinkRequests = 0
    const sink = Bun.serve({
      port: 0,
      fetch() {
        sinkRequests += 1
        return new Response(null, { status: 500 })
      },
    })
    servers.push(sink)
    const redirect = Bun.serve({
      port: 0,
      fetch() {
        return new Response(null, { status: 307, headers: { Location: sink.url.toString() } })
      },
    })
    servers.push(redirect)
    const auth = authLayer((_audience, url) => ({
      tokens: { accessToken: "must-not-redirect" },
      serverUrl: url,
    }))
    const info = new ConfigCapabilityService.Info({
      capabilities: ["document.parse.native"],
      transport: new ConfigCapabilityService.HttpTransport({
        type: "streamable-http",
        url: redirect.url.toString(),
        audience: "redirect-guard",
      }),
      locality: "lan",
      resources: new ConfigCapabilityService.Resources({
        estimated_resident_bytes: 1,
        estimated_peak_bytes: 1,
      }),
    })
    const layer = workerLayer(auth).pipe(
      Layer.provide(Global.layerWith({ data: process.cwd(), config: process.cwd() })),
    )

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const worker = yield* CapabilityServiceWorker.Service
        return yield* Effect.flip(worker.start("redirect", info))
      }).pipe(Effect.provide(layer), Effect.scoped),
    )

    expect(error).toBeInstanceOf(Error)
    expect(sinkRequests).toBe(0)
  })

  test("fails closed instead of sending an audience-bound request without a current credential", async () => {
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
    const layer = workerLayer().pipe(Layer.provide(Global.layerWith({ data: process.cwd() })))
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const worker = yield* CapabilityServiceWorker.Service
        return yield* Effect.flip(worker.start("parser", info))
      }).pipe(Effect.provide(layer)),
    )
    expect(error.message).toContain('no current credential bound to audience "parser"')
  })
})
