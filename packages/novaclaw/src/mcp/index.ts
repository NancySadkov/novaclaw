import path from "node:path"
import { pathToFileURL } from "node:url"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { McpExternal } from "@novaclaw/core/tool/mcp-external"
import { serviceUse } from "@novaclaw/core/effect/service-use"
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  ListRootsRequestSchema,
  type LoggingMessageNotification,
  LoggingMessageNotificationSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "@/config/config"
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
import { NamedError } from "@novaclaw/core/util/error"
import { InstallationVersion } from "@novaclaw/core/installation/version"
import { withTimeout } from "@/util/timeout"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Global } from "@novaclaw/core/global"
import { Offline } from "@novaclaw/core/offline"
import { Log } from "@novaclaw/schema/log"
import { Shell } from "@novaclaw/core/shell"
import { McpOAuthPendingProvider, McpOAuthProvider, OAUTH_CALLBACK_PATH } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import open from "open"
import { Cause, Effect, Exit, Layer, Context, Schema, Semaphore } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { McpCatalog } from "./catalog"
import { McpEvent } from "@novaclaw/schema/mcp-event"

const DEFAULT_TIMEOUT = 30_000
const CLIENT_OPTIONS = {
  capabilities: {
    // upstream issue #11948
    // sampling: {},
    // upstream issue #23066
    // elicitation: {},
    // upstream issue #2308
    roots: {},
    // upstream issue #28567
    // tasks: {},
  },
} satisfies ClientOptions

export const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
}).annotate({ identifier: "McpResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export const ToolsChanged = McpEvent.ToolsChanged

export const BrowserOpenFailed = McpEvent.BrowserOpenFailed

export const Failed = NamedError.create("MCPFailed", {
  name: Schema.String,
})

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("MCP.NotFoundError", {
  name: Schema.String,
}) {}

type MCPClient = Client

/**
 * Relay a foreign server's record under one of OUR event keys and one of OUR severities.
 * The server's own level is data, not authority to promote its debug output into our error stream.
 */
export function serverLog(name: string, params: LoggingMessageNotification["params"]) {
  const data = typeof params.data === "string" ? params.data : (JSON.stringify(params.data) ?? String(params.data))
  return Log.event("mcp.server.output", {
    server: name,
    "mcp.logger": params.logger ?? "",
    "mcp.level": params.level,
    "mcp.data": data,
  })
}

function createClient(directory: string) {
  const client = new Client({ name: "novaclaw", version: InstallationVersion }, CLIENT_OPTIONS)
  client.setRequestHandler(ListRootsRequestSchema, () =>
    Promise.resolve({ roots: [{ uri: pathToFileURL(directory).href }] }),
  )
  return client
}

/**
 * The pid of a local (stdio) server's child process. Accepts a client or a bare transport; anything
 * else — a remote transport, an already-closed one — yields undefined.
 *
 * ⚠️ **Must be read BEFORE `close()`.** `StdioClientTransport.close()` clears its `_process` handle on
 * its first line, after which `transport.pid` is permanently `null` — read it afterwards and you get
 * nothing to kill, silently. That is why the shutdown helpers below read it first, every time.
 */
export function stdioPid(source: unknown): number | undefined {
  const transport = source instanceof Client ? source.transport : source
  if (!(transport instanceof StdioClientTransport)) return undefined
  const pid = transport.pid
  return typeof pid === "number" && pid > 0 ? pid : undefined
}

/**
 * Kill the child process tree behind a stdio transport. No-op for a remote one.
 *
 * ⚠️ The SDK's own `close()` is not enough. It ends stdin and then signals the ROOT process only, so an
 * `npx`/`node` server that forked its own workers orphans them on **every** platform — and this runs on
 * **every settings save**, because a config write disposes the instance. Orphans at multiple GB each
 * are what hard-crashed this box on 2026-07-20 (AGENTS.md → Known pitfalls #8). `Shell.killTree` is the
 * one tree-kill in the codebase; nothing here hand-rolls a `taskkill` or a `process.kill`.
 */
const killTransportTree = (source: unknown) => {
  const pid = stdioPid(source)
  if (pid === undefined) return Effect.void
  return Effect.tryPromise(() => Shell.killTree(pid)).pipe(Effect.ignore)
}

/**
 * Shut a client down and leave NOTHING running. **Every** MCP client teardown goes through here:
 * instance disposal, `disconnect`, `remove`, the reconnect/replace path, and the OAuth bail-outs.
 *
 * Order is load-bearing:
 *  1. read the pid while the transport still has it (see {@link stdioPid});
 *  2. kill the TREE — decisive, and it closes the pid-reuse window that closing first would open
 *     (the child could exit, its pid be recycled, and our kill land on an unrelated process);
 *  3. `close()` last, to release the transport's streams and handlers. It returns quickly because the
 *     child is already gone, instead of burning its 2 s + 2 s escalation waits.
 *
 * Never fails: teardown must not be able to abort a finalizer.
 */
const shutdownClient = (client: MCPClient) =>
  Effect.gen(function* () {
    yield* killTransportTree(client)
    yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
  })

/**
 * The same, for a transport we hold without a client — the connect-failure release. A server that hung
 * during `initialize` (or blew the connect timeout) has a live child, and `transport.close()` alone
 * would orphan its descendants.
 */
const shutdownTransport = (transport: { close: () => Promise<void> }) =>
  Effect.gen(function* () {
    yield* killTransportTree(transport)
    yield* Effect.tryPromise(() => transport.close()).pipe(Effect.ignore)
  })

const StatusConnected = Schema.Struct({ status: Schema.Literal("connected") }).annotate({
  identifier: "MCPStatusConnected",
})
const StatusDisabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
const StatusFailed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }).annotate({
  identifier: "MCPStatusFailed",
})
const StatusNeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const StatusNeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
]).annotate({ identifier: "MCPStatus", discriminator: "status" })
export type Status = Schema.Schema.Type<typeof Status>

// Store transports for OAuth servers to allow finishing auth
type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
const pendingOAuthTransports = new Map<string, { transport: TransportWithAuth; provider?: McpOAuthPendingProvider }>()

// ─── v0.2.0-prep B7 tier-3 bookkeeping ──────────────────────────────────────────────────────────
//
// Module-level for the same reason `Watcher`'s counters are: the properties they make assertable are
// otherwise invisible. "The reconcile ran and left this server alone" and "the reconcile never ran"
// look identical from the outside — the second is a silent regression of the whole item, and only a
// counter can tell them apart. Module scope also makes the suppression conservative rather than
// clever: two layer builds in one process share it, so the worst case is one skipped reconcile that
// the next config write performs anyway (the diff converges).
let selfWrites = 0
let reconcilesRun = 0
let reconcilesSuppressed = 0

/** Reconciles this module has RUN (a config write reached the live server set) and SUPPRESSED (the
 *  write came from `add`/`connect`/`disconnect`, which apply themselves in memory). */
export function reconcileStats(): { readonly run: number; readonly suppressed: number } {
  return { run: reconcilesRun, suppressed: reconcilesSuppressed }
}

// Prompt cache types
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
type ResourceTemplateInfo = Awaited<ReturnType<MCPClient["listResourceTemplates"]>>["resourceTemplates"][number]
// V2 config nests MCP servers under `mcp.servers` (V1 was a flat `mcp` record). Every V2 server carries
// a `type` (the V1 `{ enabled }`-only toggle variant is gone), so isMcpConfigured is now effectively a
// defensive guard against a malformed entry.
type McpEntry = NonNullable<NonNullable<(typeof ConfigV2.Info.Type)["mcp"]>["servers"]>[string]
type McpLocal = Extract<McpEntry, { type: "local" }>
type McpRemote = Extract<McpEntry, { type: "remote" }>

function isMcpConfigured(entry: McpEntry): boolean {
  return typeof entry === "object" && entry !== null && "type" in entry
}

function remoteURL(value: string) {
  if (URL.canParse(value)) return new URL(value)
}

interface CreateResult {
  mcpClient?: MCPClient
  status: Status
  defs?: MCPToolDef[]
  instructions?: string
  requestTimeout?: number
}

interface AuthResult {
  authorizationUrl: string
  oauthState: string
  client?: MCPClient
}

// --- Effect Service ---

interface State {
  config: Record<string, McpEntry>
  status: Record<string, Status>
  clients: Record<string, MCPClient>
  defs: Record<string, MCPToolDef[]>
  instructions: Record<string, string>
}

export interface ServerInstructions {
  name: string
  instructions: string
  tools: string[]
}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  readonly instructions: () => Effect.Effect<ServerInstructions[]>
  readonly tools: () => Effect.Effect<Record<string, McpExternal.AiSdkTool>>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: (clientName?: string) => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly resourceTemplates: (
    clientName?: string,
  ) => Effect.Effect<Record<string, ResourceTemplateInfo & { client: string }>>
  /**
   * Write `mcp.servers.<name>` to the instance's config store and DO NOT connect.
   *
   * The durable half of {@link add}, exposed on its own for callers that must not spawn a child
   * process or open a socket — `nova-cli mcp add` above all, which used to write a jsonc document
   * nothing reads. Needs no instance: it touches the instance-wide settings store directly, so it
   * works headless, airgapped and with no `novaclaw serve` running.
   */
  readonly persist: (name: string, mcp: McpEntry) => Effect.Effect<void>
  readonly add: (name: string, mcp: McpEntry) => Effect.Effect<{ status: Record<string, Status> | Status }>
  readonly connect: (name: string) => Effect.Effect<Status, NotFoundError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined>
  readonly startAuth: (
    mcpName: string,
  ) => Effect.Effect<{ authorizationUrl: string; oauthState: string }, NotFoundError>
  readonly authenticate: (
    mcpName: string,
    onAuthorization?: (authorizationUrl: string) => void,
  ) => Effect.Effect<Status, NotFoundError>
  readonly finishAuth: (mcpName: string, authorizationCode: string) => Effect.Effect<Status, NotFoundError>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean, NotFoundError>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/MCP") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* McpAuth.Service
    const events = yield* EventV2Bridge.Service
    const cfgSvc = yield* Config.Service

    // ── the durable half (v0.2.0-prep B3a) ───────────────────────────────────────────────────
    //
    // `mcp` is already a SETTINGS KEY (`settings-config-seed.ts` → SETTINGS_KEYS), so
    // `mcp.servers.<name>` has a durable home in SQLite: no new table, and — more importantly — no
    // second owner for a key `ConfigStoreWrite` already routes. Every write below therefore goes
    // through `ConfigStoreWrite.apply`, the ONE config write path (`PATCH /config` and the test
    // fixture take the same one), which buys the transaction, the documented patch-MERGE semantics
    // and the post-commit hooks without restating any of them here.
    //
    // Until 2026-07-28 `add` was `s.config[name] = mcp` and nothing else: the server lived in
    // process memory, `status()` reported it, `POST /api/mcp` answered 200 — and it was gone at the
    // next boot. That is ruling 2's "a failed mutation never reports success" with the mutation
    // failing silently, and it is why the app's MCP switch did not survive a restart either.
    //
    // These services are captured at layer scope on purpose: they are instance-global singletons
    // (one `Database` per process, guarded by a single-connection semaphore), so holding them is
    // holding the same handles `PATCH /config` writes through — not a second connection.
    const configStores = {
      agents: yield* AgentConfigStore.Service,
      catalog: yield* CatalogStore.Service,
      commands: yield* CommandConfigStore.Service,
      database: yield* Database.Service,
      plugins: yield* PluginConfigStore.Service,
      references: yield* ReferenceConfigStore.Service,
      settings: yield* SettingsConfigStore.Service,
      skills: yield* SkillConfigStore.Service,
    }
    const provideConfigStores = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(AgentConfigStore.Service, configStores.agents),
        Effect.provideService(CatalogStore.Service, configStores.catalog),
        Effect.provideService(CommandConfigStore.Service, configStores.commands),
        Effect.provideService(Database.Service, configStores.database),
        Effect.provideService(PluginConfigStore.Service, configStores.plugins),
        Effect.provideService(ReferenceConfigStore.Service, configStores.references),
        Effect.provideService(SettingsConfigStore.Service, configStores.settings),
        Effect.provideService(SkillConfigStore.Service, configStores.skills),
      )

    type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

    /**
     * Connect a client via the given transport with resource safety:
     * on failure the transport is closed; on success the caller owns it.
     */
    const connectTransport = Effect.fn("MCP.connectTransport")(function* (transport: Transport, timeout: number) {
      const directory = yield* InstanceState.directory
      return yield* Effect.acquireUseRelease(
        Effect.succeed(transport),
        (t) =>
          Effect.tryPromise({
            try: () => {
              const client = createClient(directory)
              return withTimeout(client.connect(t), timeout).then(() => client)
            },
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
        // A stdio server that hung during `initialize` already HAS a child; closing the transport
        // signals only its root, so release through shutdownTransport (kills the tree first).
        (t, exit) => (Exit.isFailure(exit) ? shutdownTransport(t) : Effect.void),
      )
    })

    const DISABLED_RESULT: CreateResult = { status: { status: "disabled" } }

    const connectRemote = Effect.fn("MCP.connectRemote")(function* (
      key: string,
      mcp: McpRemote,
      connectTimeout: number,
    ) {
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      const url = remoteURL(mcp.url)
      if (!url) {
        return {
          client: undefined as MCPClient | undefined,
          status: { status: "failed" as const, error: `Invalid MCP URL for "${key}"` },
        }
      }
      // OFF-B (layer 6): the MCP SDK runs its own fetch, so the OFF-A HttpClient
      // chokepoint cannot see these connections. In offline mode a remote MCP
      // endpoint must pass the same host policy (loopback/LAN allowlist) or the
      // server is marked failed with the legible how-to-allow message.
      {
        const offline = Offline.loadPolicy({ configDir: Global.make().config })
        const verdict = Offline.checkUrl(url.toString(), offline)
        if (!verdict.allowed) {
          return {
            client: undefined as MCPClient | undefined,
            status: { status: "failed" as const, error: verdict.message },
          }
        }
      }
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.client_id,
            clientSecret: oauthConfig?.client_secret,
            scope: oauthConfig?.scope,
            callbackPort: oauthConfig?.callback_port,
            redirectUri: oauthConfig?.redirect_uri,
          },
          {
            onRedirect: async () => {},
          },
          auth,
        )
      }

      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(url, {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(url, {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
      ]

      let lastStatus: Status | undefined

      for (const { name, transport } of transports) {
        const result = yield* connectTransport(transport, connectTimeout).pipe(
          Effect.map((client) => ({ client, transportName: name })),
          Effect.catch((error) => {
            const lastError = error instanceof Error ? error : new Error(String(error))
            const isAuthError =
              error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

            if (isAuthError) {
              // The auth state lands in `lastStatus`, which the Settings UI surfaces as the
              // server's MCP status. (These used to also publish a TuiEvent toast — the TUI
              // HTTP control surface died with the TUI; the web app never consumed it.)
              if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
                lastStatus = {
                  status: "needs_client_registration" as const,
                  error: "Server does not support dynamic client registration. Please provide clientId in config.",
                }
                return Log.event("mcp.auth.registration.required", { server: key }).pipe(Effect.as(undefined))
              } else {
                pendingOAuthTransports.set(key, { transport })
                lastStatus = { status: "needs_auth" as const }
                return Log.event("mcp.auth.required", {
                  server: key,
                  "mcp.hint": `nova-cli mcp auth ${key}`,
                }).pipe(Effect.as(undefined))
              }
            }

            lastStatus = { status: "failed" as const, error: lastError.message }
            return Effect.void
          }),
        )
        if (result) return { client: result.client, status: { status: "connected" } as Status }
        // If this was an auth error, stop trying other transports
        if (lastStatus?.status === "needs_auth" || lastStatus?.status === "needs_client_registration") break
      }

      return {
        client: undefined as MCPClient | undefined,
        status: (lastStatus ?? { status: "failed", error: "Unknown error" }) as Status,
      }
    })

    const connectLocal = Effect.fn("MCP.connectLocal")(function* (key: string, mcp: McpLocal, connectTimeout: number) {
      const [cmd, ...args] = mcp.command
      const baseDir = yield* InstanceState.directory
      const cwd = mcp.cwd ? path.resolve(baseDir, mcp.cwd) : baseDir
      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args,
        cwd,
        env: {
          ...process.env,
          ...(cmd === "novaclaw" ? { BUN_BE_BUN: "1" } : {}),
          ...mcp.environment,
        },
      })

      return yield* connectTransport(transport, connectTimeout).pipe(
        Effect.map((client): { client: MCPClient | undefined; status: Status } => ({
          client,
          status: { status: "connected" },
        })),
        Effect.catch((error): Effect.Effect<{ client: MCPClient | undefined; status: Status }> => {
          const msg = error instanceof Error ? error.message : String(error)
          return Effect.succeed({ client: undefined, status: { status: "failed", error: msg } })
        }),
      )
    })

    const create = Effect.fn("MCP.create")(
      function* (key: string, mcp: McpEntry) {
        if (mcp.disabled === true) {
          return DISABLED_RESULT
        }

        const globalTimeout = (yield* cfgSvc.get()).mcp?.timeout
        const connectTimeout = mcp.timeout?.startup ?? globalTimeout?.startup ?? DEFAULT_TIMEOUT
        const requestTimeout = mcp.timeout?.request ?? globalTimeout?.request
        const { client: mcpClient, status } =
          mcp.type === "remote"
            ? yield* connectRemote(key, mcp, connectTimeout)
            : yield* connectLocal(key, mcp, connectTimeout)

        if (!mcpClient) {
          if (status.status !== "connected" && status.status !== "disabled") {
            yield* Log.event("mcp.server.unavailable", {
              server: key,
              "mcp.transport": mcp.type,
              "mcp.status": status.status,
            })
          }
          return { status } satisfies CreateResult
        }

        return yield* Effect.gen(function* () {
          const listed = mcpClient.getServerCapabilities()?.tools
            ? yield* McpCatalog.defs(mcpClient, requestTimeout)
            : []
          if (!listed) {
            return yield* Effect.fail(new Error("Failed to get tools"))
          }
          return {
            mcpClient,
            status,
            defs: listed,
            instructions: mcpClient.getInstructions()?.trim(),
            requestTimeout,
          } satisfies CreateResult
        }).pipe(
          // Tool listing failed on a client we already connected: its stdio child is RUNNING. Closing
          // alone would orphan the tree, and this path retries on every boot with a broken server.
          Effect.catchCause((cause) => shutdownClient(mcpClient).pipe(Effect.andThen(Effect.failCause(cause)))),
        )
      },
      Effect.map((result): CreateResult => result),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
        const error = Cause.squash(cause)
        return Effect.succeed<CreateResult>({
          status: { status: "failed", error: error instanceof Error ? error.message : String(error) },
        })
      }),
    )
    /**
     * Route one server entry into the config store. The ONE durable write in this module.
     *
     * ⚠️ It is a patch-MERGE, not a replace — `mergePatch` has no null-deletion, so a field the new
     * entry omits survives from the old one. That is the documented `updateConfig` contract and it
     * is what makes `add` preserve sibling servers, but it has one edge that would be a real lie:
     * re-adding a server the user had switched OFF would inherit the stale `disabled: true` and the
     * server would stay dark. Callers therefore pass `disabled` EXPLICITLY (see `add`) rather than
     * leaving it to the merge.
     *
     * The JSON round-trip is the `dirAgents` trick from `config/config.ts`: callers hand us either a
     * decoded `ConfigMCP.Server` class instance (the HTTP path) or a plain object literal (the CLI
     * and the tests), and every field of an MCP entry is JSON-native — so one round-trip normalizes
     * both into the shape `Config.Info`'s decode accepts, without depending on `instanceof`.
     *
     * Dies rather than skipping on an undecodable entry: a config write that silently drops its
     * payload while answering 200 is precisely the defect this function exists to remove.
     */
    const persistServer = Effect.fn("MCP.persistServer")(function* (name: string, mcp: McpEntry) {
      const patch = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(ConfigV2.Info)({
            mcp: { servers: { [name]: JSON.parse(JSON.stringify(mcp)) as unknown } },
          }),
        catch: (error) => {
          const reason = error instanceof Error ? error.message : String(error)
          return new Error(`mcp: server "${name}" is not a valid config entry: ${reason}`)
        },
      }).pipe(Effect.orDie)
      // ⚠️ SUPPRESSED, and this is the one place in the module that needs it. Since B7 tier-3 every
      // `ConfigStoreWrite.apply` that consumes `mcp` fans out to `reconcile` below — which is exactly
      // right for a config IMPORT and exactly wrong for this call, because `add`/`connect`/`disconnect`
      // persist first and then mutate the live state themselves. Without the guard, `add` would have
      // the reconcile spawn the new server's child and `createAndStore` immediately spawn a second and
      // tree-kill the first: correct in the end, two processes and one kill along the way. The
      // reconcile is a converging diff, so the suppressed write is not "lost" — the state this caller
      // is about to write IS the reconciled one.
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          selfWrites++
        }),
        () => provideConfigStores(ConfigStoreWrite.apply(patch)),
        () =>
          Effect.sync(() => {
            selfWrites--
          }),
      )
      // The global store view is process-wide and cached with no TTL; the per-instance merged
      // document is refreshed by the `instance_config` reload domain that `apply` above fires.
      yield* cfgSvc.invalidate()
    })

    function watch(s: State, name: string, client: MCPClient, bridge: EffectBridge.Shape, timeout?: number) {
      client.onclose = () => {
        if (s.clients[name] !== client) return
        delete s.clients[name]
        delete s.defs[name]
        delete s.instructions[name]
        s.status[name] = { status: "failed", error: "Connection closed" }
        bridge.fork(
          Log.event("mcp.connection.close", { server: name }).pipe(
            Effect.andThen(events.publish(ToolsChanged, { server: name })),
            Effect.ignore,
          ),
        )
      }

      client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) =>
        bridge.promise(serverLog(name, notification.params)),
      )

      if (!client.getServerCapabilities()?.tools) return
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        const listed = await bridge.promise(McpCatalog.defs(client, timeout))
        if (!listed) return
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        s.defs[name] = listed
        await bridge.promise(events.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      })
    }

    // ⚠️ `InstanceState.make`, NEVER `makeRematerializable` — and the finalizer below is the whole
    // reason. Re-running this initializer would close the superseded entry's scope, which walks
    // `s.clients` and tree-kills every connected server's child processes: the stop-the-world teardown
    // B7 tier-2 deleted, at a smaller size. The cure for a changed `mcp.servers` is `reconcile` below,
    // which touches only the servers that actually changed. The missing marker is what makes that a
    // compile error rather than a comment (`effect/instance-state.ts` → `Rematerializable`).
    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* () {
        const cfg = yield* cfgSvc.get()
        const bridge = yield* EffectBridge.make()
        const config = cfg.mcp?.servers ?? {}
        const s: State = {
          config: {},
          status: {},
          clients: {},
          defs: {},
          instructions: {},
        }

        yield* Effect.forEach(
          Object.entries(config),
          ([key, mcp]) =>
            Effect.gen(function* () {
              if (!isMcpConfigured(mcp)) {
                yield* Log.event("mcp.config.entry.invalid", { server: key })
                return
              }

              // `s.config` now means "the entry each server is RUNNING with", not "entries added at
              // runtime". That is what lets `reconcile` tell a changed server from an untouched one
              // without re-reading the config a second time — and it is a widening of the same
              // meaning `add`/`connect`/`disconnect` already wrote into it, so `getMcpConfig`,
              // `status()` and `requestTimeout` all keep answering exactly what they answered before
              // (they preferred this map already, and it now holds the value they fell back to).
              s.config[key] = mcp

              if (mcp.disabled === true) {
                s.status[key] = { status: "disabled" }
                return
              }

              const result = yield* create(key, mcp)
              s.status[key] = result.status
              if (result.mcpClient) {
                s.clients[key] = result.mcpClient
                s.defs[key] = result.defs!
                if (result.instructions) s.instructions[key] = result.instructions
                watch(s, key, result.mcpClient, bridge, result.requestTimeout)
              }
            }),
          { concurrency: "unbounded" },
        )

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const clients = Object.values(s.clients)
            s.clients = {}
            s.defs = {}
            s.instructions = {}
            yield* Effect.forEach(clients, shutdownClient, { concurrency: "unbounded" })
            pendingOAuthTransports.clear()
          }),
        )

        return s
      }),
    )

    function closeClient(s: State, name: string) {
      const client = s.clients[name]
      delete s.clients[name]
      delete s.defs[name]
      delete s.instructions[name]
      if (!client) return Effect.void
      // NOT a bare `client.close()`: reconfiguring or removing a server used to orphan its stdio
      // child (and everything that child spawned) on every platform. See shutdownClient.
      return shutdownClient(client)
    }

    const storeClient = Effect.fnUntraced(function* (
      s: State,
      name: string,
      client: MCPClient,
      listed: MCPToolDef[],
      instructions: string | undefined,
      timeout?: number,
    ) {
      const bridge = yield* EffectBridge.make()
      const previous = s.clients[name]
      s.status[name] = { status: "connected" }
      s.clients[name] = client
      s.defs[name] = listed
      if (instructions) s.instructions[name] = instructions
      else delete s.instructions[name]
      watch(s, name, client, bridge, timeout)
      // The REPLACE path (reconnect / re-add): the superseded client's child tree must die with it.
      if (previous) yield* shutdownClient(previous)
      return s.status[name]
    })

    const status = Effect.fn("MCP.status")(function* () {
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp?.servers ?? {}
      const result: Record<string, Status> = {}

      for (const [key, mcp] of Object.entries(config)) {
        if (!isMcpConfigured(mcp)) continue
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      for (const key of Object.keys(s.config)) {
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      return result
    })

    const clients = Effect.fn("MCP.clients")(function* () {
      const s = yield* InstanceState.get(state)
      return s.clients
    })

    const instructions = Effect.fn("MCP.instructions")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.entries(s.instructions)
        .filter(([name]) => s.status[name]?.status === "connected")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => ({
          name,
          instructions: item,
          tools: (s.defs[name] ?? []).map((tool) => McpCatalog.toolName(name, tool.name)),
        }))
    })

    const createAndStore = Effect.fn("MCP.createAndStore")(function* (name: string, mcp: McpEntry) {
      const s = yield* InstanceState.get(state)
      const result = yield* create(name, mcp)

      s.status[name] = result.status
      if (!result.mcpClient) {
        yield* closeClient(s, name)
        delete s.clients[name]
        return result.status
      }

      return yield* storeClient(s, name, result.mcpClient, result.defs!, result.instructions, result.requestTimeout)
    })

    // ─── v0.2.0-prep B7 tier-3: `mcp` applies live, WITHOUT a stop-the-world reconnect ────────────
    //
    // The gap this closes is narrow and was measured rather than assumed: the product's own MCP
    // surface (`POST /api/mcp`, the app's per-server switch, `nova-cli mcp add`) all go through
    // `add`/`connect`/`disconnect`, which persist and then mutate the live state in place — those
    // were never stale. What WAS stale is every other writer of `mcp.servers`: a config Import, a
    // `PATCH /config`, the `configure` tool. For those, the only thing that ever applied the change
    // was the instance being destroyed on save.
    //
    // ⚠️ So this is a DIFF, not a rebuild, and the difference is the entire point of the item. A
    // rebuild (or an `InstanceState.invalidate`) releases the state's scope, whose finalizer walks
    // `s.clients` → `shutdownClient` → `killTransportTree`: editing one server's timeout would kill
    // every OTHER server's child process tree. An untouched server must come through a config write
    // with the same client, the same child pid and the same tool list.

    /** Order-independent identity of an entry, so "did this server change?" cannot answer yes on key
     *  order alone. Entries arrive both as decoded `Config.Info` class instances and as plain object
     *  literals (the CLI and the tests), and JSON key order follows insertion for both. */
    const entryIdentity = (value: unknown): string =>
      JSON.stringify(value, (_key, item: unknown) =>
        item !== null && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
          : item,
      )

    /**
     * Bring the live server set in line with the stored one. Idempotent: a second run with the same
     * config does nothing at all, which is what makes it safe to fire on every `mcp` write.
     */
    const reconcile = Effect.fn("MCP.reconcile")(function* (s: State) {
      const cfg = yield* cfgSvc.get()
      const wanted = new Map<string, McpEntry>()
      for (const [name, entry] of Object.entries(cfg.mcp?.servers ?? {})) {
        if (!isMcpConfigured(entry)) {
          yield* Log.event("mcp.config.entry.invalid", { server: name })
          continue
        }
        wanted.set(name, entry)
      }

      // Removed from config: close the client (tree-kills ITS child, which is correct — the user
      // deleted the server) and forget it. `closeClient` is a no-op when nothing was connected.
      for (const name of Object.keys(s.config)) {
        if (wanted.has(name)) continue
        yield* Log.event("mcp.config.server.removed", { server: name })
        yield* closeClient(s, name)
        delete s.config[name]
        delete s.status[name]
      }

      for (const [name, entry] of wanted) {
        const applied = s.config[name]
        // THE invariant: an entry that did not change is not touched. No close, no connect, no kill.
        if (applied !== undefined && entryIdentity(applied) === entryIdentity(entry)) continue
        s.config[name] = entry
        if (entry.disabled === true) {
          yield* Log.event("mcp.config.server.disabled", { server: name })
          yield* closeClient(s, name)
          s.status[name] = { status: "disabled" }
          continue
        }
        yield* Log.event("mcp.config.server.connecting", { server: name })
        // Replaces a superseded client through `storeClient`, which shuts the old one down AFTER the
        // new one is up — the same build-before-release ordering the reconnect path already used.
        yield* createAndStore(name, entry)
      }
    })

    // One reconcile at a time, and never after teardown — the shape `filesystem/watcher.ts`
    // establishes for the same hazard: a config write racing a scope close would otherwise connect a
    // server into a state whose finalizer has already run, leaving a child process nobody owns.
    const reconcileGate = Semaphore.makeUnsafe(1)
    let disposed = false
    yield* ConfigStoreWrite.registerReload("mcp", () =>
      reconcileGate.withPermit(
        Effect.suspend(() => {
          if (disposed) return Effect.void
          // See `persistServer`: this module's own writes have already applied themselves in memory.
          if (selfWrites > 0) {
            reconcilesSuppressed++
            return Effect.void
          }
          reconcilesRun++
          return InstanceState.forEachCached(state, (s) => reconcile(s))
        }),
      ),
    )
    yield* Effect.addFinalizer(() =>
      reconcileGate.withPermit(
        Effect.sync(() => {
          disposed = true
        }),
      ),
    )

    /**
     * Add a server: persist it, then connect it.
     *
     * The order is load-bearing. Persisting FIRST means a server whose process will not start, or
     * whose URL is unreachable, is still *configured* — the user gets a `failed` status they can act
     * on instead of a server that silently vanishes at the next boot. Connecting first and
     * persisting after would make a connect failure lose the user's write, which is the same class
     * of lie in the other direction.
     *
     * `disabled` is written explicitly (see `persistServer`) so re-adding a server the user had
     * switched off actually turns it back on.
     */
    const add = Effect.fn("MCP.add")(function* (name: string, mcp: McpEntry) {
      const entry = { ...mcp, disabled: mcp.disabled ?? false } as McpEntry
      // Boot the state BEFORE the write, not after. The boot connects everything the config lists,
      // and the config is what we are about to change — write first and the boot would connect this
      // server, then `createAndStore` below would connect it a second time and tear the first down.
      const s = yield* InstanceState.get(state)
      yield* persistServer(name, entry)
      // The in-memory overlay stays: this process's `Config` is a boot-time snapshot, so `status()`,
      // `getMcpConfig` and the tool surface would not see the server we just committed without it.
      s.config[name] = entry
      yield* createAndStore(name, entry)
      return { status: s.status }
    })

    /**
     * Connect/disconnect are the app's per-server SWITCH (`dialog-select-mcp.tsx`), so what they
     * change is a durable PREFERENCE — `mcp.servers.<name>.disabled` — and that is what gets
     * written. The connection itself is a runtime fact and is deliberately NOT persisted: a stored
     * `status: "connected"` would be a claim about a process that does not exist after a crash or a
     * restart, i.e. ruling 2's "a fault is never described falsely". So the switch position
     * survives a restart and the status is re-derived by actually trying.
     */
    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const mcp = yield* requireMcpConfig(name)
      const entry = { ...mcp, disabled: false } as McpEntry
      yield* persistServer(name, entry)
      const s = yield* InstanceState.get(state)
      s.config[name] = entry
      return yield* createAndStore(name, entry)
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      const mcp = yield* requireMcpConfig(name)
      const entry = { ...mcp, disabled: true } as McpEntry
      yield* persistServer(name, entry)
      const s = yield* InstanceState.get(state)
      s.config[name] = entry
      yield* closeClient(s, name)
      delete s.clients[name]
      s.status[name] = { status: "disabled" }
    })

    function requestTimeout(s: State, name: string, configured: McpEntry | undefined, fallback?: number) {
      const staticTimeout = configured && isMcpConfigured(configured) ? configured.timeout?.request : undefined
      return s.config[name]?.timeout?.request ?? staticTimeout ?? fallback
    }

    const tools = Effect.fn("MCP.tools")(function* () {
      const result: Record<string, McpExternal.AiSdkTool> = {}
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp?.servers ?? {}
      const defaultTimeout = cfg.mcp?.timeout?.request

      for (const [clientName, client] of Object.entries(s.clients)) {
        if (s.status[clientName]?.status !== "connected") continue
        const mcpConfig = config[clientName]
        const listed = s.defs[clientName]
        if (!listed) {
          yield* Log.event("mcp.tool.cache.missing", { server: clientName })
          continue
        }
        const timeout = requestTimeout(s, clientName, mcpConfig, defaultTimeout)
        for (const mcpTool of listed) {
          const key = McpCatalog.toolName(clientName, mcpTool.name)
          result[key] = McpCatalog.convertTool(mcpTool, client, timeout)
        }
      }
      return result
    })

    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client, timeout?: number) => Promise<T[]>,
      label: string,
      key?: (item: T) => string,
      targetClientName?: string,
    ) {
      return Effect.gen(function* () {
        const cfg = yield* cfgSvc.get()
        return yield* Effect.forEach(
          Object.entries(s.clients).filter(
            ([name]) => s.status[name]?.status === "connected" && (!targetClientName || name === targetClientName),
          ),
          ([clientName, client]) =>
            McpCatalog.fetch(
              clientName,
              client,
              (c) =>
                listFn(c, requestTimeout(s, clientName, cfg.mcp?.servers?.[clientName], cfg.mcp?.timeout?.request)),
              label,
              key,
            ).pipe(Effect.map((items) => Object.entries(items ?? {}))),
          { concurrency: "unbounded" },
        ).pipe(Effect.map((results) => Object.fromEntries<T & { client: string }>(results.flat())))
      })
    }

    const prompts = Effect.fn("MCP.prompts")(function* () {
      return yield* collectFromConnected(yield* InstanceState.get(state), McpCatalog.prompts, "prompts")
    })

    const resources = Effect.fn("MCP.resources")(function* (clientName?: string) {
      return yield* collectFromConnected(
        yield* InstanceState.get(state),
        McpCatalog.resources,
        "resources",
        (resource) => resource.uri,
        clientName,
      )
    })

    const resourceTemplates = Effect.fn("MCP.resourceTemplates")(function* (clientName?: string) {
      return yield* collectFromConnected(
        yield* InstanceState.get(state),
        McpCatalog.resourceTemplates,
        "resource templates",
        (template) => template.uriTemplate,
        clientName,
      )
    })

    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: MCPClient, timeout?: number) => Promise<A>,
      label: string,
      target: string,
    ) {
      const s = yield* InstanceState.get(state)
      const client = s.clients[clientName]
      if (!client) {
        yield* Log.event("mcp.request.client.missing", { server: clientName, "mcp.operation": label })
        return undefined
      }
      const cfg = yield* cfgSvc.get()
      return yield* Effect.tryPromise({
        try: () => fn(client, requestTimeout(s, clientName, cfg.mcp?.servers?.[clientName], cfg.mcp?.timeout?.request)),
        catch: (error) => error,
      }).pipe(
        Effect.tapError((error) =>
          Log.event("mcp.request.failed", {
            server: clientName,
            "mcp.operation": label,
            "mcp.target": target,
            "mcp.error": error instanceof Error ? error.message : String(error),
          }),
        ),
        Effect.orElseSucceed(() => undefined),
      )
    })

    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      return yield* withClient(
        clientName,
        (client, timeout) => client.getPrompt({ name, arguments: args }, { timeout }),
        "getPrompt",
        name,
      )
    })

    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      return yield* withClient(
        clientName,
        (client, timeout) => client.readResource({ uri: resourceUri }, { timeout }),
        "readResource",
        resourceUri,
      )
    })

    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const s = yield* InstanceState.get(state)
      if (s.config[mcpName]) return s.config[mcpName]

      const cfg = yield* cfgSvc.get()
      const mcpConfig = cfg.mcp?.servers?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig)) return undefined
      return mcpConfig
    })

    const requireMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return yield* new NotFoundError({ name: mcpName })
      return mcpConfig
    })

    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
      if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
      const url = remoteURL(mcpConfig.url)
      if (!url) throw new Error(`Invalid MCP URL for "${mcpName}"`)

      // OAuth config is optional - if not provided, we'll use auto-discovery
      const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined

      // Resolve effective redirect URI: explicit redirect_uri > callback_port shorthand > default
      const effectiveRedirectUri =
        oauthConfig?.redirect_uri ??
        (oauthConfig?.callback_port ? `http://127.0.0.1:${oauthConfig.callback_port}${OAUTH_CALLBACK_PATH}` : undefined)

      // Start the callback server with custom redirectUri if configured
      yield* Effect.promise(() => McpOAuthCallback.ensureRunning(effectiveRedirectUri))

      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      yield* auth.updateOAuthState(mcpName, oauthState)
      let capturedUrl: URL | undefined
      const authProvider = new McpOAuthPendingProvider(
        mcpName,
        mcpConfig.url,
        {
          clientId: oauthConfig?.client_id,
          clientSecret: oauthConfig?.client_secret,
          scope: oauthConfig?.scope,
          redirectUri: effectiveRedirectUri,
        },
        {
          onRedirect: async (url) => {
            capturedUrl = url
          },
        },
        auth,
      )

      const transport = new StreamableHTTPClientTransport(url, {
        authProvider,
        requestInit: mcpConfig.headers ? { headers: mcpConfig.headers } : undefined,
      })
      const directory = yield* InstanceState.directory
      const globalTimeout = (yield* cfgSvc.get()).mcp?.timeout
      const connectTimeout = mcpConfig.timeout?.startup ?? globalTimeout?.startup ?? DEFAULT_TIMEOUT

      return yield* Effect.tryPromise({
        try: () => {
          const client = createClient(directory)
          return withTimeout(client.connect(transport), connectTimeout).then(async () => {
            await authProvider.commit()
            return { authorizationUrl: "", oauthState, client } satisfies AuthResult
          })
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof UnauthorizedError && capturedUrl) {
            pendingOAuthTransports.set(mcpName, { transport, provider: authProvider })
            return Effect.succeed({ authorizationUrl: capturedUrl.toString(), oauthState } satisfies AuthResult)
          }
          return shutdownTransport(transport).pipe(Effect.andThen(Effect.die(error)))
        }),
      )
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (
      mcpName: string,
      onAuthorization?: (authorizationUrl: string) => void,
    ) {
      const result = yield* startAuth(mcpName)
      if (!result.authorizationUrl) {
        const client = "client" in result ? result.client : undefined
        const mcpConfig = yield* requireMcpConfig(mcpName).pipe(
          Effect.tapError(() => (client ? shutdownClient(client) : Effect.void)),
        )

        const globalTimeout = (yield* cfgSvc.get()).mcp?.timeout
        const requestTimeout = mcpConfig.timeout?.request ?? globalTimeout?.request
        const listed = client
          ? client.getServerCapabilities()?.tools
            ? yield* McpCatalog.defs(client, requestTimeout)
            : []
          : undefined
        if (!client || !listed) {
          if (client) yield* shutdownClient(client)
          return { status: "failed", error: "Failed to get tools" } satisfies Status
        }

        const s = yield* InstanceState.get(state)
        yield* auth.clearOAuthState(mcpName)
        return yield* storeClient(s, mcpName, client, listed, client.getInstructions()?.trim(), requestTimeout)
      }

      const callbackPromise = McpOAuthCallback.waitForCallback(result.oauthState, mcpName)
      onAuthorization?.(result.authorizationUrl)

      yield* Effect.tryPromise(() => open(result.authorizationUrl)).pipe(
        Effect.flatMap((subprocess) =>
          Effect.callback<void, Error>((resume) => {
            const timer = setTimeout(() => resume(Effect.void), 500)
            subprocess.on("error", (err) => {
              clearTimeout(timer)
              resume(Effect.fail(err))
            })
            subprocess.on("exit", (code) => {
              if (code !== null && code !== 0) {
                clearTimeout(timer)
                resume(Effect.fail(new Error(`Browser open failed with exit code ${code}`)))
              }
            })
          }),
        ),
        Effect.catch(() => {
          return events.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)
        }),
      )

      const code = yield* Effect.promise(() => callbackPromise)

      const storedState = yield* auth.getOAuthState(mcpName)
      if (storedState !== result.oauthState) {
        yield* auth.clearOAuthState(mcpName)
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      yield* auth.clearOAuthState(mcpName)
      return yield* finishAuth(mcpName, code)
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (mcpName: string, authorizationCode: string) {
      yield* requireMcpConfig(mcpName)
      const pending = pendingOAuthTransports.get(mcpName)
      if (!pending) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)

      const error = yield* Effect.tryPromise({
        try: () => pending.transport.finishAuth(authorizationCode),
        catch: (error) => error,
      }).pipe(
        Effect.match({
          onFailure: (error) => (error instanceof Error ? error.message : String(error)),
          onSuccess: () => undefined,
        }),
      )

      if (error) return { status: "failed", error: `OAuth completion failed: ${error}` } satisfies Status

      yield* Effect.promise(() => pending.provider?.commit() ?? Promise.resolve())
      yield* auth.clearCodeVerifier(mcpName)
      pendingOAuthTransports.delete(mcpName)

      const mcpConfig = yield* requireMcpConfig(mcpName)

      return yield* createAndStore(mcpName, { ...mcpConfig, disabled: false })
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      yield* auth.remove(mcpName)
      McpOAuthCallback.cancelPending(mcpName)
      pendingOAuthTransports.delete(mcpName)
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* requireMcpConfig(mcpName)
      return mcpConfig.type === "remote" && mcpConfig.oauth !== false
    })

    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      return !!entry?.tokens
    })

    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const runtimeConfig = (yield* InstanceState.has(state))
        ? (yield* InstanceState.get(state)).config[mcpName]
        : undefined
      const mcpConfig = runtimeConfig ?? (yield* cfgSvc.get()).mcp?.servers?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig) || mcpConfig.type !== "remote") return "not_authenticated"
      const entry = yield* auth.getForUrl(mcpName, mcpConfig.url)
      if (!entry?.tokens) return "not_authenticated"
      if (entry.tokens.expiresAt && entry.tokens.expiresAt < Date.now() / 1000) return "expired"
      return "authenticated"
    })

    return Service.of({
      status,
      clients,
      instructions,
      tools,
      prompts,
      resources,
      resourceTemplates,
      persist: persistServer,
      add,
      connect,
      disconnect,
      getPrompt,
      readResource,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

// --- Per-service runtime ---

export const defaultLayer = layer.pipe(
  Layer.provide(McpAuth.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  // B3a: the config stores this module now WRITES through. They were already built inside
  // `Config.defaultLayer` — `Layer.provide` just hid them, so listing them here exposes the same
  // instances rather than constructing a second set.
  Layer.provide(AgentConfigStore.defaultLayer),
  Layer.provide(CatalogStore.defaultLayer),
  Layer.provide(CommandConfigStore.defaultLayer),
  Layer.provide(PluginConfigStore.defaultLayer),
  Layer.provide(ReferenceConfigStore.defaultLayer),
  Layer.provide(SettingsConfigStore.defaultLayer),
  Layer.provide(SkillConfigStore.defaultLayer),
  Layer.provide(Database.defaultLayer),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  // CrossSpawnSpawner was dropped with the hand-rolled `pgrep -P` descendant BFS: teardown is
  // pid-based through Shell.killTree now, so nothing here spawns a probe process.
  //
  // B3a added the config stores. They cost no extra build: `Config.node` already depends on all
  // seven (and every one of them on `Database.node`), and `LayerNode.compile` walks a root through
  // ONE cache — so these resolve to the very layers `Config` got. What listing them buys is that
  // the compiled graph EXPORTS them, which is what lets `MCP.add` reach `ConfigStoreWrite.apply`
  // instead of mutating a record that dies with the process.
  deps: [
    McpAuth.node,
    EventV2Bridge.node,
    Config.node,
    AgentConfigStore.node,
    CatalogStore.node,
    CommandConfigStore.node,
    PluginConfigStore.node,
    ReferenceConfigStore.node,
    SettingsConfigStore.node,
    SkillConfigStore.node,
    Database.node,
  ],
})

export * as MCP from "."
