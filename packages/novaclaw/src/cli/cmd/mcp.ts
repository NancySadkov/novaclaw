import { cmd } from "./cmd"
import { CommandSpec } from "../command-spec"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import { effectCmd, fail } from "../effect-cmd"
import { Cause } from "effect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { MCP } from "../../mcp"
import { McpAuth } from "../../mcp/auth"
import { McpOAuthProvider } from "../../mcp/oauth-provider"
import { Config } from "@/config/config"
import { InstallationVersion } from "@novaclaw/core/installation/version"
import { Effect } from "effect"

function getAuthStatusIcon(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "✓"
    case "expired":
      return "⚠"
    case "not_authenticated":
      return "✗"
  }
}

function getAuthStatusText(status: MCP.AuthStatus): string {
  switch (status) {
    case "authenticated":
      return "authenticated"
    case "expired":
      return "expired"
    case "not_authenticated":
      return "not authenticated"
  }
}

/**
 * 🔴 **Exit 2 — the invocation is missing something only the caller can supply.**
 *
 * Distinct from 1 ("the work was attempted and failed") so a provisioning script can tell "you
 * called me wrong" from "authentication was refused" without parsing prose. Every leaf below that
 * uses it used to open a blocking prompt instead, which principle 14 forbids structurally: a
 * headless CLI has nobody to answer it, and a killed process's output is discarded, so the operator
 * saw nothing at all. Answer immediately, or do not ask — so we refuse and name what is needed.
 */
const EXIT_USAGE = 2

// V2 nests servers under `mcp.servers`; every server carries a `type`.
type McpEntry = NonNullable<NonNullable<ConfigV2.Info["mcp"]>["servers"]>[string]

type McpRemote = Extract<McpEntry, { type: "remote" }>
function isMcpRemote(config: McpEntry): config is McpRemote {
  return config.type === "remote"
}

function configuredServers(config: ConfigV2.Info): [string, McpEntry][] {
  return Object.entries(config.mcp?.servers ?? {})
}

function oauthServers(config: ConfigV2.Info) {
  return configuredServers(config).filter(
    (entry): entry is [string, McpRemote] => isMcpRemote(entry[1]) && entry[1].oauth !== false,
  )
}

function listState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = yield* cfg.get()
    const statuses = yield* mcp.status()
    const stored = yield* Effect.all(
      Object.fromEntries(configuredServers(config).map(([name]) => [name, mcp.hasStoredTokens(name)])),
      { concurrency: "unbounded" },
    )
    return { config, statuses, stored }
  })
}

function authState() {
  return Effect.gen(function* () {
    const cfg = yield* Config.Service
    const mcp = yield* MCP.Service
    const config = yield* cfg.get()
    const auth = yield* Effect.all(
      Object.fromEntries(oauthServers(config).map(([name]) => [name, mcp.getAuthStatus(name)])),
      { concurrency: "unbounded" },
    )
    return { config, auth }
  })
}

export const McpCommand = cmd({
  ...CommandSpec.mcp,
  builder: (yargs) =>
    yargs
      .command(McpAddCommand)
      .command(McpListCommand)
      .command(McpAuthCommand)
      .command(McpLogoutCommand)
      .command(McpDebugCommand)
      .demandCommand(),
  async handler() {},
})

export const McpListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list MCP servers and their status",
  handler: Effect.fn("Cli.mcp.list")(function* () {
    UI.empty()
    prompts.intro("MCP Servers")

    const { config, statuses, stored } = yield* listState()
    const servers = configuredServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No MCP servers configured")
      prompts.outro("Add servers with: nova-cli mcp add")
      return
    }

    for (const [name, serverConfig] of servers) {
      const status = statuses[name]
      const hasOAuth = isMcpRemote(serverConfig) && !!serverConfig.oauth
      const hasStoredTokens = stored[name]

      let statusIcon: string
      let statusText: string
      let hint = ""

      if (!status) {
        statusIcon = "○"
        statusText = "not initialized"
      } else if (status.status === "connected") {
        statusIcon = "✓"
        statusText = "connected"
        if (hasOAuth && hasStoredTokens) {
          hint = " (OAuth)"
        }
      } else if (status.status === "disabled") {
        statusIcon = "○"
        statusText = "disabled"
      } else if (status.status === "needs_auth") {
        statusIcon = "⚠"
        statusText = "needs authentication"
      } else if (status.status === "needs_client_registration") {
        statusIcon = "✗"
        statusText = "needs client registration"
        hint = "\n    " + status.error
      } else {
        statusIcon = "✗"
        statusText = "failed"
        hint = "\n    " + status.error
      }

      const typeHint = serverConfig.type === "remote" ? serverConfig.url : serverConfig.command.join(" ")
      prompts.log.info(
        `${statusIcon} ${name} ${UI.Style.TEXT_DIM}${statusText}${hint}\n    ${UI.Style.TEXT_DIM}${typeHint}`,
      )
    }

    prompts.outro(`${servers.length} server(s)`)
  }),
})

export const McpAuthCommand = effectCmd({
  command: "auth [name]",
  describe: "authenticate with an OAuth-enabled MCP server",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .command(McpAuthListCommand),
  handler: Effect.fn("Cli.mcp.auth")(function* (args) {
    UI.empty()
    prompts.intro("MCP OAuth Authentication")

    const { config, auth } = yield* authState()
    const mcpServers = config.mcp?.servers ?? {}
    const servers = oauthServers(config)

    // ⚠️ Every arm below used to be `log.error(...); outro("Done"); return` — which exits **0**.
    // `nova-cli mcp auth my-server && echo ok` printed the error AND "ok", and any provisioning
    // script gating on it proceeded against an unauthenticated server. A failed mutation never
    // reports success (ruling 2), so each one is now a `fail`.
    if (servers.length === 0) {
      return yield* fail(
        [
          "No OAuth-capable MCP servers configured.",
          // Was: "add a remote server in novaclaw.json", with a V1-shaped flat `mcp` snippet. Both
          // halves were wrong — servers nest under `mcp.servers`, and a hand-edited jsonc is not
          // read at runtime at all (config is SQLite). Point at the command that actually writes.
          "Remote MCP servers support OAuth by default. Add one with:",
          "  nova-cli mcp add my-server --url https://example.com/mcp",
        ].join("\n"),
      )
    }

    // ⚠️ Was a `Select MCP server to authenticate` prompt. The list it would have rendered is the
    // same information, so print it and refuse rather than wait for a keystroke nobody will send.
    const serverName = args.name
    if (!serverName) {
      return yield* fail(
        [
          "mcp auth needs the name of the server to authenticate.",
          "  nova-cli mcp auth <name>",
          ...servers.map(([name]) => `    ${getAuthStatusIcon(auth[name])} ${name} (${getAuthStatusText(auth[name])})`),
        ].join("\n"),
        EXIT_USAGE,
      )
    }

    const serverConfig = mcpServers[serverName]
    if (!serverConfig) return yield* fail(`MCP server not found: ${serverName}`)

    if (!isMcpRemote(serverConfig) || serverConfig.oauth === false) {
      return yield* fail(`MCP server ${serverName} is not an OAuth-capable remote server`)
    }

    // Check if already authenticated
    const authStatus = auth[serverName] ?? (yield* MCP.Service.use((mcp) => mcp.getAuthStatus(serverName)))
    // ⚠️ Was `prompts.confirm({message: "… already has valid credentials. Re-authenticate?"})`,
    // reached WITH the positional supplied — so the fully-specified, non-interactive invocation
    // still blocked on a human forever. There is no question to ask: the caller named this server
    // and asked for it to be authenticated. Say what is happening and do it, which also keeps
    // `mcp auth <name>` idempotent for a provisioning script that runs it twice.
    if (authStatus === "authenticated") {
      prompts.log.info(`${serverName} already has valid credentials — re-authenticating.`)
    } else if (authStatus === "expired") {
      prompts.log.warn(`${serverName} has expired credentials. Re-authenticating...`)
    }

    const spinner = prompts.spinner()
    spinner.start("Starting OAuth flow...")

    /**
     * 🔴 **`spinner.stop(msg, 1)`'s `1` is a clack RENDERING flag, not an exit code.**
     *
     * Both arms below used to end the handler normally — the `catchCause` converted the cause into
     * a SUCCESS and returned, and the non-`connected` statuses simply fell through to
     * `outro("Done")`. So `mcp auth my-server` printed "Authentication failed" and exited **0**,
     * which is worse than a crash for a headless tool: a script cannot tell. Both now carry the
     * reason out as a value and refuse below.
     */
    const failure = yield* MCP.Service.use((mcp) =>
      mcp.authenticate(serverName, (url) => {
        spinner.stop("Authorize in your browser:")
        prompts.log.info(url)
        spinner.start("Waiting for authorization...")
      }),
    ).pipe(
      Effect.map((status): string | undefined => {
        if (status.status === "connected") {
          spinner.stop("Authentication successful!")
          return undefined
        }
        if (status.status === "needs_client_registration") {
          spinner.stop("Authentication failed", 1)
          // Was a jsonc snippet under a V1-flat `mcp` key with camelCase `clientId`/`clientSecret`
          // — three ways wrong at once (dead file, wrong nesting, wrong field names; the schema is
          // `mcp.servers.<name>.oauth.client_id`). It then pointed at `mcp add` "(interactive)",
          // which no longer exists: that wizard was one of the eight blocking leaves. Settings is
          // where the runtime reads this from, and it is the one route that can carry a secret.
          prompts.log.info(
            `Set mcp.servers.${serverName}.oauth.client_id (and client_secret, if the provider ` +
              `issued one) in Settings → MCP, then run this command again.`,
          )
          return status.error
        }
        if (status.status === "failed") {
          spinner.stop("Authentication failed", 1)
          return status.error
        }
        spinner.stop("Unexpected status: " + status.status, 1)
        return `unexpected authentication status: ${String(status.status)}`
      }),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          spinner.stop("Authentication failed", 1)
          const error = Cause.squash(cause)
          return error instanceof Error ? error.message : String(error)
        }),
      ),
    )
    if (failure) return yield* fail(`Authentication failed for "${serverName}": ${failure}`)

    prompts.outro("Done")
  }),
})

export const McpAuthListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list OAuth-capable MCP servers and their auth status",
  handler: Effect.fn("Cli.mcp.auth.list")(function* () {
    UI.empty()
    prompts.intro("MCP OAuth Status")

    const { config, auth } = yield* authState()
    const servers = oauthServers(config)

    if (servers.length === 0) {
      prompts.log.warn("No OAuth-capable MCP servers configured")
      prompts.outro("Done")
      return
    }

    for (const [name, serverConfig] of servers) {
      const authStatus = auth[name]
      const icon = getAuthStatusIcon(authStatus)
      const statusText = getAuthStatusText(authStatus)
      const url = serverConfig.url

      prompts.log.info(`${icon} ${name} ${UI.Style.TEXT_DIM}${statusText}\n    ${UI.Style.TEXT_DIM}${url}`)
    }

    prompts.outro(`${servers.length} OAuth-capable server(s)`)
  }),
})

export const McpLogoutCommand = effectCmd({
  command: "logout [name]",
  describe: "remove OAuth credentials for an MCP server",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
    }),
  handler: Effect.fn("Cli.mcp.logout")(function* (args) {
    UI.empty()
    prompts.intro("MCP OAuth Logout")

    const credentials = yield* McpAuth.Service.use((auth) => auth.all())
    const serverNames = Object.keys(credentials)

    // ⚠️ All three arms used to exit 0, so `mcp logout <typo>` was indistinguishable from a
    // successful logout — the removal never happened and the caller was told it had.
    if (serverNames.length === 0) return yield* fail("No MCP OAuth credentials stored")

    // ⚠️ Was a `Select MCP server to logout` prompt. Same information, printed and refused.
    const serverName = args.name
    if (!serverName) {
      return yield* fail(
        [
          "mcp logout needs the name of the server to log out from.",
          "  nova-cli mcp logout <name>",
          ...serverNames.map((name) => {
            const entry = credentials[name]
            const held = [entry.tokens ? "tokens" : undefined, entry.clientInfo ? "client registration" : undefined]
              .filter(Boolean)
              .join(" + ")
            return `    ${name}${held ? ` (${held})` : ""}`
          }),
        ].join("\n"),
        EXIT_USAGE,
      )
    }

    if (!credentials[serverName]) return yield* fail(`No credentials found for: ${serverName}`)

    yield* MCP.Service.use((mcp) => mcp.removeAuth(serverName))
    prompts.log.success(`Removed OAuth credentials for ${serverName}`)
    prompts.outro("Done")
  }),
})

// The V2 config authoring shape for one MCP server entry (`mcp.servers.<name>`), assembled from
// flags/prompts and handed to `MCP.persist`, which decodes it against `ConfigMCP.Server` before it
// reaches the store. Mirrors `ConfigMCP.Local`/`Remote`.
type McpServerWrite =
  | {
      type: "local"
      command: string[]
      cwd?: string
      environment?: Record<string, string>
      disabled?: boolean
    }
  | {
      type: "remote"
      url: string
      headers?: Record<string, string>
      oauth?:
        | false
        | {
            client_id?: string
            client_secret?: string
            scope?: string
            callback_port?: number
            redirect_uri?: string
          }
      disabled?: boolean
    }

/**
 * Write one server into the instance's config store — the same `ConfigStoreWrite.apply` route
 * `PATCH /config` and the Settings UI take.
 *
 * ⚠️ This command used to write a jsonc document instead, and on any instance that had booted once
 * that was a TOTAL no-op: `mcp` is served from SQLite, and the jsonc seed that could have imported
 * it is `isEmpty`-gated and one-time (`settings-config-seed.ts:311-337`). The file was written, the
 * command printed "added", and nothing — not even a restart — ever read it back. Persisting instead
 * of connecting is deliberate: `MCP.add` would spawn the child/open the socket for EVERY configured
 * server, which is not what a one-shot `add` should cost.
 */
function persistServer(name: string, mcpConfig: McpServerWrite) {
  // `disabled` is written EXPLICITLY, exactly as `MCP.add` does it and for the same reason: the
  // store write is a patch-MERGE, so re-adding a server the user had switched off would otherwise
  // inherit the stale `disabled: true` and the server would silently stay dark.
  const entry = { ...mcpConfig, disabled: mcpConfig.disabled ?? false }
  // `McpEntry` is the DECODED shape (`ConfigMCP.Server` class instances); what we hold is the plain
  // authoring literal. `MCP.persist` re-decodes it against the schema before it reaches the store,
  // so the cast crosses exactly one hop and the validation still happens.
  return MCP.Service.use((mcp) => mcp.persist(name, entry as unknown as McpEntry))
}

/**
 * What a user needs to know after the write lands, and nothing more.
 *
 * There is no instance to "reach" — the write goes straight to the instance's own SQLite store, so
 * it works headless and airgapped with no `novaclaw serve` running and no port to discover. What it
 * does NOT do is reconfigure a serve that is ALREADY running: that process snapshots its config at
 * boot (v0.2.0-prep B7 is the fix), so say so rather than let the user believe a live instance just
 * picked the server up.
 */
const ADDED_HINT = "It is connected the next time the instance starts (restart a running one to pick it up)."

/** `KEY=VALUE` pairs, or the message naming the pair that is not one. */
function parsePairs(values: string[], kind: string): Record<string, string> | string {
  const out: Record<string, string> = {}
  for (const entry of values) {
    const index = entry.indexOf("=")
    if (index < 1) return `Invalid ${kind}: ${entry}. Expected KEY=VALUE`
    out[entry.slice(0, index)] = entry.slice(index + 1)
  }
  return out
}

export const McpAddCommand = effectCmd({
  command: "add [name]",
  describe: "add an MCP server",
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "name of the MCP server",
        type: "string",
      })
      .option("url", {
        describe: "URL for a remote MCP server",
        type: "string",
      })
      .option("env", {
        describe: "environment variable for a local MCP server (KEY=VALUE)",
        type: "string",
        array: true,
      })
      .option("header", {
        describe: "HTTP header for a remote MCP server (KEY=VALUE)",
        type: "string",
        array: true,
      }),
  handler: Effect.fn("Cli.mcp.add")(function* (args) {
    const command = args["--"] ?? []
    /**
     * 🔴 **The interactive wizard is deleted, not gated.**
     *
     * `mcp add` with no name used to walk seven blocking prompts (name, type, command/url, three
     * confirms, a password) with no flag able to answer any of them. Principle 14 forbids that
     * structurally — not "unless a TTY", not "unless a timeout": a headless CLI has nobody to
     * answer, and a killed process's output is discarded, so the operator saw nothing. Every field
     * the wizard collected already has a flag EXCEPT the OAuth client id/secret, and a secret does
     * not belong on argv anyway — Settings is where the runtime reads those from.
     */
    if (!args.name) {
      return yield* fail(
        [
          "mcp add needs a server name and how to reach it.",
          "  nova-cli mcp add <name> --url <url> [--header K=V]     a remote server",
          "  nova-cli mcp add <name> [--env K=V] -- <command...>    a local server",
          "OAuth client credentials are set in Settings → MCP; a secret does not belong on argv.",
        ].join("\n"),
        EXIT_USAGE,
      )
    }
    // ⚠️ These were `throw new Error(...)` inside an `Effect.promise`, i.e. DEFECTS: the user saw
    // "Unexpected error" and a raw message rather than a named refusal. They are usage errors.
    if (!!args.url === !!command.length) {
      return yield* fail("Provide either --url <url> or a command after --", EXIT_USAGE)
    }
    if (args.url && !URL.canParse(args.url)) return yield* fail(`Invalid URL: ${args.url}`, EXIT_USAGE)
    if (args.url && args.env?.length) return yield* fail("--env is only valid for local MCP servers", EXIT_USAGE)
    if (command.length && args.header?.length) {
      return yield* fail("--header is only valid for remote MCP servers", EXIT_USAGE)
    }

    const environment = parsePairs(args.env ?? [], "environment variable")
    if (typeof environment === "string") return yield* fail(environment, EXIT_USAGE)
    const headers = parsePairs(args.header ?? [], "HTTP header")
    if (typeof headers === "string") return yield* fail(headers, EXIT_USAGE)

    const mcpConfig: McpServerWrite = args.url
      ? {
          type: "remote",
          url: args.url,
          ...(Object.keys(headers).length ? { headers } : {}),
        }
      : {
          type: "local",
          command,
          ...(Object.keys(environment).length ? { environment } : {}),
        }

    yield* persistServer(args.name, mcpConfig)
    prompts.log.success(`MCP server "${args.name}" added to this instance's config.`)
    prompts.log.info(ADDED_HINT)
  }),
})

export const McpDebugCommand = effectCmd({
  command: "debug <name>",
  describe: "debug OAuth connection for an MCP server",
  builder: (yargs) =>
    yargs.positional("name", {
      describe: "name of the MCP server",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.mcp.debug")(function* (args) {
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const mcp = yield* MCP.Service
    const auth = yield* McpAuth.Service
    const serverConfig = config.mcp?.servers?.[args.name]
    const authInfo =
      serverConfig && isMcpRemote(serverConfig) && serverConfig.oauth !== false
        ? yield* Effect.all({
            authStatus: mcp.getAuthStatus(args.name),
            entry: auth.get(args.name),
          })
        : undefined

    // ⚠️ These three refusals used to live INSIDE the `Effect.promise` below, where a `return` ends
    // the async body successfully — so `mcp debug <typo>` printed "MCP server not found" and exited
    // **0**. Hoisting them out is what makes the refusal reach the exit code at all; the checks
    // themselves already ran out here (they decide whether `authInfo` is fetched).
    if (!serverConfig) return yield* fail(`MCP server not found: ${args.name}`)
    if (!isMcpRemote(serverConfig)) return yield* fail(`MCP server ${args.name} is not a remote server`)
    if (serverConfig.oauth === false) {
      return yield* fail(`MCP server ${args.name} has OAuth explicitly disabled`)
    }

    yield* Effect.promise(async () => {
      UI.empty()
      prompts.intro("MCP OAuth Debug")

      const serverName = args.name

      prompts.log.info(`Server: ${serverName}`)
      prompts.log.info(`URL: ${serverConfig.url}`)

      const { authStatus, entry } = authInfo!
      prompts.log.info(`Auth status: ${getAuthStatusIcon(authStatus)} ${getAuthStatusText(authStatus)}`)

      if (entry?.tokens) {
        prompts.log.info(
          `  Access token: ${entry.tokens.accessToken.length > 8 ? `${entry.tokens.accessToken.slice(0, 4)}***${entry.tokens.accessToken.slice(-4)}` : "***"}`,
        )
        if (entry.tokens.expiresAt) {
          const expiresDate = new Date(entry.tokens.expiresAt * 1000)
          const isExpired = entry.tokens.expiresAt < Date.now() / 1000
          prompts.log.info(`  Expires: ${expiresDate.toISOString()} ${isExpired ? "(EXPIRED)" : ""}`)
        }
        if (entry.tokens.refreshToken) {
          prompts.log.info(`  Refresh token: present`)
        }
      }
      if (entry?.clientInfo) {
        prompts.log.info(`  Client ID: ${entry.clientInfo.clientId}`)
        if (entry.clientInfo.clientSecretExpiresAt) {
          const expiresDate = new Date(entry.clientInfo.clientSecretExpiresAt * 1000)
          prompts.log.info(`  Client secret expires: ${expiresDate.toISOString()}`)
        }
      }

      const spinner = prompts.spinner()
      spinner.start("Testing connection...")

      // Test basic HTTP connectivity first
      try {
        const response = await fetch(serverConfig.url, {
          method: "POST",
          headers: {
            ...serverConfig.headers,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            method: "initialize",
            params: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "novaclaw-debug", version: InstallationVersion },
            },
            id: 1,
          }),
        })

        spinner.stop(`HTTP response: ${response.status} ${response.statusText}`)

        // Check for WWW-Authenticate header
        const wwwAuth = response.headers.get("www-authenticate")
        if (wwwAuth) {
          prompts.log.info(`WWW-Authenticate: ${wwwAuth}`)
        }

        if (response.status === 401) {
          prompts.log.info("Initial unauthenticated check returned 401, so this server requires OAuth")

          // Try to discover OAuth metadata
          const oauthConfig = typeof serverConfig.oauth === "object" ? serverConfig.oauth : undefined
          const authProvider = new McpOAuthProvider(
            serverName,
            serverConfig.url,
            {
              clientId: oauthConfig?.client_id,
              clientSecret: oauthConfig?.client_secret,
              scope: oauthConfig?.scope,
              redirectUri: oauthConfig?.redirect_uri,
            },
            {
              onRedirect: async () => {},
            },
            auth,
          )

          prompts.log.info("Testing OAuth flow (without completing authorization)...")

          // Try creating transport with auth provider to trigger discovery
          const transport = new StreamableHTTPClientTransport(new URL(serverConfig.url), {
            authProvider,
            requestInit: serverConfig.headers ? { headers: serverConfig.headers } : undefined,
          })

          try {
            const client = new Client({
              name: "novaclaw-debug",
              version: InstallationVersion,
            })
            await client.connect(transport)
            prompts.log.success("Connection successful (already authenticated)")
            await client.close()
          } catch (error) {
            if (error instanceof UnauthorizedError) {
              prompts.log.info(`OAuth flow triggered: ${error.message}`)

              // Check if dynamic registration would be attempted
              const clientInfo = await authProvider.clientInformation()
              if (clientInfo) {
                prompts.log.info(`Client ID available: ${clientInfo.client_id}`)
              } else {
                prompts.log.info("No client ID - dynamic registration will be attempted")
              }
            } else {
              prompts.log.error(`Connection error: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        } else if (response.status >= 200 && response.status < 300) {
          prompts.log.success("Server responded successfully (no auth required or already authenticated)")
          const body = await response.text()
          try {
            const json = JSON.parse(body)
            if (json.result?.serverInfo) {
              prompts.log.info(`Server info: ${JSON.stringify(json.result.serverInfo)}`)
            }
          } catch {
            // Not JSON, ignore
          }
        } else {
          prompts.log.warn(`Unexpected status: ${response.status}`)
          const body = await response.text().catch(() => "")
          if (body) {
            prompts.log.info(`Response body: ${body.substring(0, 500)}`)
          }
        }
      } catch (error) {
        spinner.stop("Connection failed", 1)
        prompts.log.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
      }

      prompts.outro("Debug complete")
    })
  }),
})
