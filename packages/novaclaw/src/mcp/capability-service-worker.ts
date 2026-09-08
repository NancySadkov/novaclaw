export * as McpCapabilityServiceWorker from "./capability-service-worker"

import { CapabilityServiceWorker } from "@novaclaw/core/capability-service-worker"
import type { ConfigCapabilityService } from "@novaclaw/core/config/capability-service"
import { makeGlobalNode } from "@novaclaw/core/effect/app-node"
import { Global } from "@novaclaw/core/global"
import { Offline } from "@novaclaw/core/offline"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { Effect, Exit, Layer } from "effect"
import { withTimeout } from "@/util/timeout"
import { createClient, shutdownClient, shutdownTransport } from "."
import { McpAuth } from "./auth"

type Live = { readonly client: Client; readonly info: ConfigCapabilityService.Info; readonly declaration: string }

const declarationKey = (info: ConfigCapabilityService.Info) => JSON.stringify(info)

const observeProtocol = (transport: Transport) => {
  let negotiated: string | undefined
  const forward = transport.setProtocolVersion?.bind(transport)
  transport.setProtocolVersion = (version) => {
    negotiated = version
    forward?.(version)
  }
  return () => negotiated
}

const validateContract = async (
  serviceID: string,
  client: Client,
  info: ConfigCapabilityService.Info,
  negotiated: () => string | undefined,
) => {
  const revision = negotiated()
  if (revision === undefined) throw new Error(`Capability service "${serviceID}" did not negotiate an MCP revision`)
  if (info.protocol_revision !== undefined && revision !== info.protocol_revision)
    throw new Error(
      `Capability service "${serviceID}" negotiated MCP ${revision}; config requires ${info.protocol_revision}`,
    )

  const missing = new Set(info.capabilities)
  const cursors = new Set<string>()
  let cursor: string | undefined
  while (missing.size > 0) {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor })
    for (const tool of page.tools) {
      if (!missing.has(tool.name)) continue
      if (tool.inputSchema.type !== "object")
        throw new Error(`Capability service "${serviceID}" tool "${tool.name}" has no object input schema`)
      missing.delete(tool.name)
    }
    cursor = page.nextCursor
    if (cursor === undefined) break
    if (cursors.has(cursor)) throw new Error(`Capability service "${serviceID}" repeated its tools cursor`)
    cursors.add(cursor)
  }
  if (missing.size > 0)
    throw new Error(
      `Capability service "${serviceID}" does not expose declared tool${missing.size === 1 ? "" : "s"}: ${[...missing].join(", ")}`,
    )
}

export const layer = Layer.effect(
  CapabilityServiceWorker.Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const auth = yield* McpAuth.Service
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
        const declaration = declarationKey(info)
        const current = live.get(serviceID)
        if (current?.declaration === declaration) return
        if (current !== undefined) yield* stop(serviceID)
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
          const url = yield* Effect.try({
            try: () => new URL(http.url),
            catch: () => new Error(`Capability service "${serviceID}" has an invalid URL`),
          })
          const verdict = Offline.checkUrl(url.toString(), Offline.loadPolicy({ configDir: global.config }))
          if (!verdict.allowed) return yield* Effect.fail(new Error(verdict.message))
          let requestInit: RequestInit | undefined
          if (http.audience !== undefined) {
            const entry = yield* auth.getForUrl(http.audience, url.toString())
            const tokens = entry?.tokens
            if (
              tokens === undefined ||
              tokens.accessToken.length === 0 ||
              (tokens.expiresAt !== undefined && tokens.expiresAt <= Date.now() / 1000)
            )
              return yield* Effect.fail(
                new Error(
                  `Capability service "${serviceID}" has no current credential bound to audience "${http.audience}" and ${url.origin}`,
                ),
              )
            requestInit = {
              headers: { Authorization: `Bearer ${tokens.accessToken}` },
              // The credential is bound to this exact configured resource URL. Never let fetch
              // carry it to a redirect target with a different audience.
              redirect: "error",
            }
          }
          transport = new StreamableHTTPClientTransport(url, requestInit === undefined ? undefined : { requestInit })
        }
        const client = createClient(global.data)
        const timeout = info.warmup_timeout_ms ?? 30_000
        const negotiated = observeProtocol(transport)
        yield* Effect.acquireUseRelease(
          Effect.succeed(transport),
          (owned) =>
            Effect.tryPromise({
              try: () =>
                withTimeout(
                  client.connect(owned).then(() => validateContract(serviceID, client, info, negotiated)),
                  timeout,
                ),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            }),
          (owned, exit) => (Exit.isFailure(exit) ? shutdownTransport(owned) : Effect.void),
        )
        live.set(serviceID, { client, info, declaration })
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
  deps: [Global.node, McpAuth.node],
})
