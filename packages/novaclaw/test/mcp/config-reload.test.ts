import { beforeEach, describe, expect, mock } from "bun:test"
import { Effect, Schema } from "effect"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { Database } from "@novaclaw/core/database/database"
import { PluginConfigStore } from "@novaclaw/core/plugin-config-store"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import type { MCP as MCPNS } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"

/**
 * **v0.2.0-prep B7 tier-3 — `mcp` applies live, and an untouched server keeps its child process.**
 *
 * 🔴 This is the invariant the whole item is FOR, and it is proven rather than theoretical. Before
 * tier-2, saving any preference ran `markInstanceForDisposal`, which released the instance's layer
 * graph — including `MCP.state`, whose finalizer walks `s.clients` and calls `shutdownClient` →
 * `killTransportTree`. Editing an unrelated setting therefore tree-killed every connected MCP
 * server's child processes. Tier-2 deleted the teardown; the obvious way to re-apply `mcp` after that
 * — an `InstanceState.invalidate` or a rematerialise of `MCP.state` — reintroduces the exact same
 * behaviour at a smaller size, because both release that same scope.
 *
 * So the cure is a targeted reconcile, and this file is what stops the easy version from coming back:
 *
 *  · a server the write did not mention keeps the SAME client object, and is never closed;
 *  · a server the write ADDED is connected;
 *  · a server whose entry CHANGED is reconnected — the discriminator, without which "leaves the
 *    untouched one alone" would also be satisfied by a reconcile that does nothing at all;
 *  · a server that left the config is closed.
 *
 * ⚠️ NO REAL CHILD PROCESSES. The SDK's transport and client are mocked, and `MockStdioTransport.pid`
 * stays `null` for the reason `lifecycle.test.ts` records at length: `killTransportTree` routes a
 * non-null pid into `Shell.killTree`, which would `taskkill /f /t` whatever unrelated process on the
 * developer's box happened to hold that number. A close is therefore observed through the mock's own
 * bookkeeping, which is also the more precise assertion — it names WHICH server was closed.
 */

// ─── the mocks: keyed by server name, which the fixture passes as the command's first argument ────

/** Every client that reached `connect`, by server name. Identity matters — see the tests. */
const connected = new Map<string, MockClient>()
/** Servers whose client was closed, and whose transport was closed. Kept apart so a shutdown that
 *  reaches only one half is still visible. */
const clientClosed: string[] = []
const transportClosed: string[] = []
let clientCreateCount = 0

class MockStdioTransport {
  stderr: null = null
  /** ⚠️ MUST stay null — see the header. */
  pid: number | null = null
  name: string
  constructor(opts: { command: string; args?: string[] }) {
    this.name = opts.args?.[0] ?? opts.command
  }
  async start() {}
  async close() {
    transportClosed.push(this.name)
  }
}

class MockClient {
  name = "<unconnected>"
  transport: MockStdioTransport | undefined
  constructor() {
    clientCreateCount++
  }
  async connect(transport: MockStdioTransport) {
    this.transport = transport
    this.name = transport.name
    await transport.start()
    connected.set(this.name, this)
  }
  setRequestHandler() {}
  setNotificationHandler() {}
  getServerCapabilities() {
    return { tools: {} }
  }
  getInstructions() {
    return undefined
  }
  async listTools() {
    return { tools: [{ name: `${this.name}-tool`, inputSchema: { type: "object" } }] }
  }
  async request(_request: unknown, schema: { parse: (value: unknown) => unknown }) {
    return schema.parse({ tools: [{ name: `${this.name}-tool`, inputSchema: { type: "object" } }] })
  }
  async close() {
    clientClosed.push(this.name)
  }
}

void mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: MockStdioTransport }))
void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: MockClient }))
void mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class extends Error {},
}))

beforeEach(() => {
  connected.clear()
  clientClosed.length = 0
  transportClosed.length = 0
  clientCreateCount = 0
})

// Imported after the mocks are registered.
const { MCP } = await import("../../src/mcp/index")

const configStores = LayerNode.compile(
  LayerNode.group([
    Database.node,
    AgentConfigStore.node,
    CatalogStore.node,
    CommandConfigStore.node,
    PluginConfigStore.node,
    ReferenceConfigStore.node,
    SettingsConfigStore.node,
    SkillConfigStore.node,
  ]),
)

/** Write the way `PATCH /config` and Config Import do — the chokepoint whose fan-out is under test. */
const applyPatch = (patch: Record<string, unknown>) =>
  ConfigStoreWrite.apply(Schema.decodeUnknownSync(ConfigV2.Info)(patch)).pipe(Effect.provide(configStores))

type McpEntry = Parameters<MCPNS.Interface["add"]>[1]

/** One stdio server whose "command" carries its own name, which is how the mocks above key state. */
// Inferred, not cast to `McpEntry`: the fixture takes the ENCODED config shape, while `McpEntry` is
// the DECODED union (`Local | Remote`) — asserting into it made every `servers` literal below
// unassignable. The literal is already exactly what the config carries.
const server = (name: string) => ({ type: "local" as const, command: ["mock-mcp", name] })

const it = testEffect(LayerNode.compile(MCP.node))

const statusOf = (statuses: Record<string, { status: string }>, name: string) => statuses[name]?.status

describe("B7 tier-3 — a config write reconciles MCP instead of rebuilding it", () => {
  it.instance(
    "adds the new server and leaves the untouched one connected, with the SAME client",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        // Boot the state: `keep` connects.
        expect(statusOf(yield* mcp.status(), "keep")).toBe("connected")
        const keepClient = (yield* mcp.clients())["keep"]
        expect(keepClient).toBeDefined()
        const createdAtBoot = clientCreateCount
        const runs = MCP.reconcileStats().run

        yield* applyPatch({ mcp: { servers: { added: server("added") } } })

        // The reconcile ran (rather than the write silently doing nothing).
        expect(MCP.reconcileStats().run).toBe(runs + 1)

        const statuses = yield* mcp.status()
        expect(statusOf(statuses, "added")).toBe("connected")
        expect(statusOf(statuses, "keep")).toBe("connected")

        // 🔴 THE INVARIANT: identity, not just status. A rebuild would answer "connected" too —
        // with a different client behind a different child process, and the old one killed.
        expect((yield* mcp.clients())["keep"]).toBe(keepClient)
        expect(clientClosed).toEqual([])
        expect(transportClosed).toEqual([])
        // Exactly ONE new client: the added server. A rebuild would have re-created `keep` as well.
        expect(clientCreateCount).toBe(createdAtBoot + 1)

        // The added server's tools are live without a restart.
        expect(Object.keys(yield* mcp.tools())).toContain("added_added-tool")
      }),
    { config: { mcp: { servers: { keep: server("keep") } } } },
  )

  it.instance(
    "DISCRIMINATOR — a server whose own entry changed IS reconnected",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        expect(statusOf(yield* mcp.status(), "edit")).toBe("connected")
        const first = (yield* mcp.clients())["edit"]

        // Without this case, "the untouched server survives" would also be satisfied by a reconcile
        // that never touches anything — i.e. by the defect, passing.
        yield* applyPatch({
          mcp: { servers: { edit: { type: "local", command: ["mock-mcp", "edit"], timeout: { request: 4321 } } } },
        })

        expect(statusOf(yield* mcp.status(), "edit")).toBe("connected")
        const second = (yield* mcp.clients())["edit"]
        expect(second).not.toBe(first)
        // The superseded client is shut down AFTER its replacement is up (`storeClient`).
        expect(clientClosed).toEqual(["edit"])
      }),
    { config: { mcp: { servers: { edit: server("edit") } } } },
  )

  it.instance(
    "a server that left the config is closed",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        expect(statusOf(yield* mcp.status(), "gone")).toBe("connected")

        // A PATCH is a merge and cannot delete a key, so the removal is staged in the store the way a
        // whole-document replacement would leave it, and then a write is issued to trigger the fan-out.
        yield* Effect.provide(
          Effect.gen(function* () {
            const settings = yield* SettingsConfigStore.Service
            yield* settings.set("mcp", { servers: {} })
          }),
          configStores,
        )
        yield* applyPatch({ mcp: {} })

        expect(clientClosed).toEqual(["gone"])
        expect(statusOf(yield* mcp.status(), "gone")).toBeUndefined()
      }),
    { config: { mcp: { servers: { gone: server("gone") } } } },
  )

  it.instance(
    "the product's OWN add path is not double-connected by the reconcile",
    () =>
      Effect.gen(function* () {
        const mcp = yield* MCP.Service
        yield* mcp.status()
        const suppressed = MCP.reconcileStats().suppressed
        const createdAtBoot = clientCreateCount

        // `add` persists through `ConfigStoreWrite.apply` and then applies itself in memory. If the
        // reconcile were not suppressed for this writer it would spawn the server first and `add`
        // would immediately spawn a second and tree-kill the first — two children and one kill for
        // one click.
        yield* mcp.add("viaAdd", server("viaAdd"))

        // The user-visible fact first: ONE child, not two, and nothing killed.
        expect(clientCreateCount).toBe(createdAtBoot + 1)
        expect(clientClosed).toEqual([])
        expect(MCP.reconcileStats().suppressed).toBe(suppressed + 1)
        expect(statusOf(yield* mcp.status(), "viaAdd")).toBe("connected")
      }),
    { config: { mcp: { servers: {} } } },
  )
})
