export * as McpCapabilityServiceWorker from "./capability-service-worker"

import { CapabilityServiceWorker } from "@novaclaw/core/capability-service-worker"
import type { ConfigCapabilityService } from "@novaclaw/core/config/capability-service"
import { makeGlobalNode } from "@novaclaw/core/effect/app-node"
import { Global } from "@novaclaw/core/global"
import { Offline } from "@novaclaw/core/offline"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { Effect, Exit, Layer } from "effect"
import { withTimeout } from "@/util/timeout"
import { createClient, shutdownClient, shutdownTransport } from "."

type Live = { readonly client: Client; readonly info: ConfigCapabilityService.Info }

export const layer = Layer.effect(
  CapabilityServiceWorker.Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const live = new Map<string, Live>()

    const stop = Effect.fn("McpCapabilityServiceWorker.stop")(function* (serviceID: string) {
      const found = live.get(serviceID)
      if (found === undefined) return
      live.delete(serviceID)
      yield* shutdownClient(found.client)
    })

    yield* Effect.addFinalizer(() => Effect.forEach([...live.keys()], stop, { discard: true }).pipe(Effect.ignore))

    return CapabilityServiceWorker.Service.of({
      start: Effect.fn("McpCapabilityServiceWorker.start")(function* (serviceID, info) {
        if (live.has(serviceID)) return
        let transport: StdioClientTransport | StreamableHTTPClientTransport
        if (info.transport.type === "stdio") {
          const [command, ...args] = info.transport.command
          if (!command) return yield* Effect.fail(new Error(`Capability service "${serviceID}" has no command`))
          const env = getDefaultEnvironment()
          for (const name of info.transport.credential_env ?? []) {
            const value = process.env[name]
            if (value === undefined)
              return yield* Effect.fail(new Error(`Capability service "${serviceID}" needs environment variable ${name}`))
            env[name] = value
          }
          transport = new StdioClientTransport({ command, args, cwd: global.data, env, stderr: "pipe" })
        } else {
          const http = info.transport
          if (http.audience !== undefined)
            return yield* Effect.fail(
              new Error(`Capability service "${serviceID}" requires audience-bound authorization, which is not available`),
            )
          const url = yield* Effect.try({
            try: () => new URL(http.url),
            catch: () => new Error(`Capability service "${serviceID}" has an invalid URL`),
          })
          const verdict = Offline.checkUrl(url.toString(), Offline.loadPolicy({ configDir: global.config }))
          if (!verdict.allowed) return yield* Effect.fail(new Error(verdict.message))
          transport = new StreamableHTTPClientTransport(url)
        }
        const client = createClient(global.data)
        const timeout = info.warmup_timeout_ms ?? 30_000
        yield* Effect.acquireUseRelease(
          Effect.succeed(transport),
          (owned) =>
            Effect.tryPromise({
              try: () => withTimeout(client.connect(owned), timeout),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            }),
          (owned, exit) => (Exit.isFailure(exit) ? shutdownTransport(owned) : Effect.void),
        )
        live.set(serviceID, { client, info })
      }),
      run: Effect.fn("McpCapabilityServiceWorker.run")(function* (input) {
        const found = live.get(input.serviceID)
        if (found === undefined) return yield* Effect.fail(new Error(`Capability service "${input.serviceID}" is not loaded`))
        if (!found.info.capabilities.includes(input.capability))
          return yield* Effect.fail(
            new Error(`Capability service "${input.serviceID}" does not declare ${input.capability}`),
          )
        return yield* Effect.tryPromise({
          try: () => found.client.callTool({ name: input.capability, arguments: { ...input.arguments } }),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })
      }),
      stop,
      health: Effect.fn("McpCapabilityServiceWorker.health")(function* (serviceID, timeoutMs) {
        const found = live.get(serviceID)
        if (found === undefined) return false
        yield* Effect.tryPromise({
          try: () => withTimeout(found.client.ping(), timeoutMs ?? found.info.health?.timeout_ms ?? 5_000),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })
        return true
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: CapabilityServiceWorker.Service,
  layer,
  deps: [Global.node],
})
