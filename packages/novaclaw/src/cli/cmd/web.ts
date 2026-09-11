import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { resolveNetworkOptions } from "../network"
import { withServerOptions, applyCredentialOptions, warnOnIgnoredEnv } from "../credential-options"
import { Flag } from "@novaclaw/core/flag/flag"
import { ServerLaunchCredential } from "@novaclaw/core/server-launch-credential"
import { memoMap } from "@novaclaw/core/effect/memo-map"
import open from "open"
import { networkInterfaces } from "os"
import { CommandSpec } from "../command-spec"

function getNetworkIPs() {
  const nets = networkInterfaces()
  const results: string[] = []

  for (const name of Object.keys(nets)) {
    const net = nets[name]
    if (!net) continue

    for (const netInfo of net) {
      // Skip internal and non-IPv4 addresses
      if (netInfo.internal || netInfo.family !== "IPv4") continue

      // Skip Docker bridge networks (typically 172.x.x.x)
      if (netInfo.address.startsWith("172.")) continue

      results.push(netInfo.address)
    }
  }

  return results
}

export const WebCommand = effectCmd({
  // `$0` makes this the DEFAULT command: a bare `novaclaw` opens the web UI. Deliberate — the HTML UI
  // is the product and the CLI is vestigial (AGENTS.md → Identity & mission), so the friendliest
  // no-argument behaviour is to show a person the thing they came for, not a help page. `db.ts`'s
  // `$0 [query]` is nested inside its own subcommand builder, so there is no top-level collision.
  ...CommandSpec.web,
  // Server loads instances per-request via x-novaclaw-directory header — no
  // ambient project InstanceContext needed at startup.
  instance: false,
  // Inline, like `cmd/serve.ts`: assigning a generic helper in `CommandSpec` instead makes yargs infer
  // `T = unknown` and the handler loses the concrete option types. Exactly one builder for this command.
  builder: (yargs) => withServerOptions(yargs),
  handler: Effect.fn("Cli.web")(function* (args) {
    // Before the server graph assembles — see the same call in `serve.ts` for why the order is the
    // contract. `web` is the DEFAULT command (`$0`), so this is the path a person's bare `novaclaw`
    // takes, and it is the one where an open server matters most: it opens a browser straight at it.
    applyCredentialOptions(args)
    warnOnIgnoredEnv((line) => UI.println(UI.Style.TEXT_WARNING_BOLD + "!  " + line))
    const { Server } = yield* Effect.promise(() => import("../../server/server"))
    if (!ServerLaunchCredential.isSet()) {
      UI.println(
        UI.Style.TEXT_WARNING_BOLD +
          "!  no --password given and no stored token, so this instance accepts unauthenticated requests.",
      )
    }
    const opts = yield* resolveNetworkOptions(args)
    // ONE instance graph, as in `serve.ts`: this command runs under `AppRuntime`. `ListenOptions.memoMap`.
    const server = yield* Effect.promise(() => Server.listen({ ...opts, memoMap }))
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()

    if (opts.hostname === "0.0.0.0") {
      // Show localhost for local access
      const localhostUrl = `http://localhost:${server.port}`
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Local access:      ", UI.Style.TEXT_NORMAL, localhostUrl)

      // Show network IPs for remote access
      const networkIPs = getNetworkIPs()
      if (networkIPs.length > 0) {
        for (const ip of networkIPs) {
          UI.println(
            UI.Style.TEXT_INFO_BOLD + "  Network access:    ",
            UI.Style.TEXT_NORMAL,
            `http://${ip}:${server.port}`,
          )
        }
      }

      if (opts.mdns) {
        UI.println(
          UI.Style.TEXT_INFO_BOLD + "  mDNS:              ",
          UI.Style.TEXT_NORMAL,
          `${opts.mdnsDomain}:${server.port}`,
        )
      }

      // Open localhost in browser — unless something is driving this rather than someone.
      if (!Flag.NOVACLAW_NO_OPEN) open(localhostUrl).catch(() => {})
    } else {
      const displayUrl = server.url.toString()
      UI.println(UI.Style.TEXT_INFO_BOLD + "  Web interface:    ", UI.Style.TEXT_NORMAL, displayUrl)
      if (!Flag.NOVACLAW_NO_OPEN) open(displayUrl).catch(() => {})
    }

    yield* Effect.never
  }),
})
