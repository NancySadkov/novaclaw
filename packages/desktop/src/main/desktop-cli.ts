import { basename } from "node:path"

export type DesktopMode = "both" | "client" | "server"

export type DesktopLaunchOptions = {
  readonly mode: DesktopMode
  readonly desktopService?: boolean
  readonly connect?: {
    readonly url: string
    readonly username?: string
    readonly password?: string
  }
  readonly server: {
    readonly hostname: string
    readonly port?: number
    readonly username: string
    readonly password?: string
    readonly cors: readonly string[]
    readonly mdns: boolean
    readonly mdnsDomain: string
    readonly supervise: boolean
  }
}

export type DesktopInvocation =
  | { readonly action: "launch"; readonly options: DesktopLaunchOptions }
  | { readonly action: "help" }
  | { readonly action: "version" }
  | { readonly action: "error"; readonly message: string }

const RETIRED_HOME = /^--(?:user-data-dir|home-dir)(?:=|$)/
const CLIENT_OPTIONS = new Set(["--connect", "--connect-username", "--connect-password"])
const SERVER_OPTIONS = new Set([
  "--hostname",
  "--port",
  "--username",
  "--password",
  "--cors",
  "--mdns",
  "--no-mdns",
  "--mdns-domain",
  "--supervise",
  "--no-supervise",
])

/** Parse NovaClaw's public options while leaving Electron/Chromium switches untouched. */
export function parseDesktopInvocation(argv: readonly string[]): DesktopInvocation {
  if (argv.some((arg) => arg === "-h" || arg === "--help")) return { action: "help" }
  if (argv.some((arg) => arg === "--version")) return { action: "version" }

  const retired = argv.find((arg) => RETIRED_HOME.test(arg))
  if (retired !== undefined)
    return { action: "error", message: `option '${retired.split("=", 1)[0]}' has been renamed to '--home'` }

  const clientOnly = argv.includes("--client-only")
  const serverOnly = argv.includes("--server-only")
  if (clientOnly && serverOnly) return error("options '--client-only' and '--server-only' cannot be used together")
  const mode: DesktopMode = clientOnly ? "client" : serverOnly ? "server" : "both"
  const desktopService = argv.includes("--desktop-service")
  if (desktopService && mode !== "server") return error("option '--desktop-service' requires '--server-only'")

  const values = new Map<string, string[]>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined || !arg.startsWith("--")) continue
    const separator = arg.indexOf("=")
    const name = separator === -1 ? arg : arg.slice(0, separator)
    const takesValue = name === "--home" || CLIENT_OPTIONS.has(name) || (SERVER_OPTIONS.has(name) && !isBoolean(name))
    if (!takesValue) continue
    const value = separator === -1 ? argv[++i] : arg.slice(separator + 1)
    if (value === undefined || value.trim() === "" || (separator === -1 && value.startsWith("-")))
      return error(`option '${name}' requires a value`)
    values.set(name, [...(values.get(name) ?? []), value])
  }

  if (mode === "client") {
    const offending = firstPresent(argv, SERVER_OPTIONS)
    if (offending) return error(`server option '${offending}' cannot be used with '--client-only'`)
    if (!value(values, "--connect")) return error("option '--client-only' requires '--connect=URL'")
  }
  if (mode === "server") {
    const offending = firstPresent(argv, CLIENT_OPTIONS)
    if (offending) return error(`client option '${offending}' cannot be used with '--server-only'`)
    if (argv.some((arg) => arg.startsWith("novaclaw://") || arg.toLowerCase().endsWith(".nova")))
      return error("a link or .nova package cannot be opened with '--server-only'")
  }
  if (mode !== "client" && firstPresent(argv, CLIENT_OPTIONS))
    return error("client connection options require '--client-only'")

  const connectUrl = value(values, "--connect")
  if (connectUrl) {
    try {
      const url = new URL(connectUrl)
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error()
    } catch {
      return error("option '--connect' requires an http:// or https:// URL")
    }
  }

  const rawPort = value(values, "--port")
  const port = rawPort === undefined ? undefined : Number(rawPort)
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535))
    return error("option '--port' must be a whole number from 0 to 65535")

  const mdns = booleanValue(argv, "--mdns", false)
  return {
    action: "launch",
    options: {
      mode,
      ...(desktopService ? { desktopService: true } : {}),
      ...(connectUrl
        ? {
            connect: {
              url: connectUrl,
              ...(value(values, "--connect-username") ? { username: value(values, "--connect-username") } : {}),
              ...(value(values, "--connect-password") ? { password: value(values, "--connect-password") } : {}),
            },
          }
        : {}),
      server: {
        hostname: value(values, "--hostname") ?? (mdns ? "0.0.0.0" : "127.0.0.1"),
        ...(port === undefined ? {} : { port }),
        username: value(values, "--username") ?? "novaclaw",
        ...(value(values, "--password") ? { password: value(values, "--password") } : {}),
        cors: values.get("--cors") ?? [],
        mdns,
        mdnsDomain: value(values, "--mdns-domain") ?? "novaclaw.local",
        supervise: booleanValue(argv, "--supervise", true),
      },
    },
  }
}

function error(message: string): DesktopInvocation {
  return { action: "error", message }
}

function value(values: ReadonlyMap<string, readonly string[]>, name: string) {
  return values.get(name)?.at(-1)
}

function isBoolean(name: string) {
  return name === "--mdns" || name === "--no-mdns" || name === "--supervise" || name === "--no-supervise"
}

function optionName(arg: string) {
  const separator = arg.indexOf("=")
  return separator === -1 ? arg : arg.slice(0, separator)
}

function firstPresent(argv: readonly string[], names: ReadonlySet<string>) {
  return argv.map(optionName).find((name) => names.has(name))
}

function booleanValue(argv: readonly string[], name: string, fallback: boolean) {
  let result = fallback
  for (const arg of argv) {
    if (arg === name || arg === `${name}=true`) result = true
    if (arg === `--no-${name.slice(2)}` || arg === `${name}=false`) result = false
  }
  return result
}

export function desktopExecutableName(execPath: string): string {
  return basename(execPath.replaceAll("\\", "/")) || "NovaClaw.exe"
}

/** GCC-style: compact synopsis and aligned option groups for the two executable roles. */
export function desktopHelp(executable = "NovaClaw.exe"): string {
  return `Usage: ${executable} [OPTION]... [novaclaw://URL | recipe.nova]
Launch the NovaClaw client and server. Both run unless one is selected alone.

General options:
  --home=DIR                 Store this instance's files in DIR.
  --client-only              Open only the client (requires --connect).
  --server-only              Run only the headless server.
  -h, --help                 Display this help and exit.
  --version                  Display the version and exit.

Client options (with --client-only):
  --connect=URL              Connect to an http:// or https:// NovaClaw server.
  --connect-username=USER    HTTP Basic username for that server.
  --connect-password=TOKEN   HTTP Basic password (visible in the process list).

Server options:
  --hostname=HOST            Listen on HOST (default: 127.0.0.1).
  --port=PORT                Listen on PORT; 0 chooses a free port.
  --username=USER            HTTP Basic username (default: novaclaw).
  --password=TOKEN           HTTP Basic password (visible in the process list).
  --cors=ORIGIN              Allow a CORS origin; may be repeated.
  --mdns                     Advertise the server using mDNS.
  --mdns-domain=DOMAIN       mDNS name (default: novaclaw.local).
  --[no-]supervise           Restart a crashed server (default: enabled).

Arguments:
  novaclaw://URL             Open a NovaClaw link in the client.
  recipe.nova                 Preview a recipe package in the client.
`
}

export function desktopOptionError(executable: string, message: string): string {
  return `${executable}: ${message}\nTry '${executable} --help' for more information.\n`
}
