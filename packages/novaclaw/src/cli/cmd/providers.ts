import { Auth } from "../../auth"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import * as Prompt from "../effect/prompt"
import { ModelsDev } from "@novaclaw/core/models-dev"

import { map, pipe, sortBy, values } from "remeda"
import path from "path"
import os from "os"
import { Config } from "@/config/config"
import { Global } from "@novaclaw/core/global"
import { Effect } from "effect"
import { CommandSpec } from "../command-spec"

/**
 * 🔴 **Exit 2 — the invocation is missing something only the caller can supply.**
 *
 * Distinct from 1 ("the work was attempted and failed") so a provisioning script can tell "you
 * called me wrong" from "authentication was refused" without parsing prose. These leaves used to
 * open a blocking prompt instead, which principle 14 forbids structurally: a headless CLI has
 * nobody to answer it, and a killed process's output is discarded, so the operator saw nothing at
 * all. Answer immediately, or do not ask — so we refuse and name what is needed.
 */
const EXIT_USAGE = 2

/** The one non-interactive channel for a secret. Not a flag: argv is visible in the process table. */
const API_KEY_ENV = "NOVACLAW_API_KEY"

export const ProvidersCommand = cmd({
  ...CommandSpec.providers,
  builder: (yargs) =>
    yargs.command(ProvidersListCommand).command(ProvidersLoginCommand).command(ProvidersLogoutCommand).demandCommand(),
  async handler() {},
})

export const ProvidersListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list providers and credentials",
  // Lists global credentials + provider env vars; no project instance needed.
  instance: false,
  handler: Effect.fn("Cli.providers.list")(function* (_args) {
    const authSvc = yield* Auth.Service
    const modelsDev = yield* ModelsDev.Service

    UI.empty()
    const authPath = path.join(Global.Path.data, "auth.json")
    const homedir = os.homedir()
    const displayPath = authPath.startsWith(homedir) ? authPath.replace(homedir, "~") : authPath
    yield* Prompt.intro(`Credentials ${UI.Style.TEXT_DIM}${displayPath}`)
    const results = Object.entries(yield* Effect.orDie(authSvc.all()))
    const database = yield* modelsDev.get()

    for (const [providerID, result] of results) {
      const name = database[providerID]?.name || providerID
      yield* Prompt.log.info(`${name} ${UI.Style.TEXT_DIM}${result.type}`)
    }

    yield* Prompt.outro(`${results.length} credentials`)

    const activeEnvVars: Array<{ provider: string; envVar: string }> = []

    for (const [providerID, provider] of Object.entries(database)) {
      for (const envVar of provider.env) {
        if (process.env[envVar]) {
          activeEnvVars.push({
            provider: provider.name || providerID,
            envVar,
          })
        }
      }
    }

    if (activeEnvVars.length > 0) {
      UI.empty()
      yield* Prompt.intro("Environment")

      for (const { provider, envVar } of activeEnvVars) {
        yield* Prompt.log.info(`${provider} ${UI.Style.TEXT_DIM}${envVar}`)
      }

      yield* Prompt.outro(`${activeEnvVars.length} environment variable` + (activeEnvVars.length === 1 ? "" : "s"))
    }
  }),
})

export const ProvidersLoginCommand = effectCmd({
  command: "login",
  describe: "log in to a provider",
  builder: (yargs) =>
    yargs.option("provider", {
      alias: ["p"],
      describe: "provider id or name to log in to (skips provider selection)",
      type: "string",
    }),
  // `--method` / `-m` is gone: it selected among the login methods a V1 plugin's `auth` hook
  // declared, and that hook (and the whole V1 plugin arm) is deleted. With nothing to choose
  // between, keeping the flag would have advertised a selection that never happens.
  handler: Effect.fn("Cli.providers.login")(function* (args) {
    const authSvc = yield* Auth.Service

    UI.empty()
    yield* Prompt.intro("Add credential")
    const cfgSvc = yield* Config.Service
    const modelsDev = yield* ModelsDev.Service
    yield* Effect.ignore(modelsDev.refresh(true))

    const config = yield* cfgSvc.get()

    const disabled = new Set(config.disabled_providers ?? [])
    const enabled = config.enabled_providers ? new Set(config.enabled_providers) : undefined

    const allProviders = yield* modelsDev.get()
    const providers: Record<string, (typeof allProviders)[string]> = {}
    for (const [key, value] of Object.entries(allProviders)) {
      if ((enabled ? enabled.has(key) : true) && !disabled.has(key)) providers[key] = value
    }
    const priority: Record<string, number> = {
      novaclaw: 0,
      openai: 1,
      google: 2,
      anthropic: 3,
      openrouter: 4,
      vercel: 5,
    }
    const options = [
      ...pipe(
        providers,
        values(),
        sortBy(
          (x) => priority[x.id] ?? 99,
          (x) => x.name ?? x.id,
        ),
        map((x) => ({
          label: x.name,
          value: x.id,
          hint: {
            novaclaw: "recommended",
            openai: "ChatGPT Plus/Pro or API key",
          }[x.id],
        })),
      ),
    ]

    // ⚠️ No `Select provider` prompt, and no "Other" free-text escape behind it. Both blocked on a
    // human; the "Other" branch additionally told the user to "configure it in novaclaw.json",
    // a file no booted instance reads (config is SQLite). An unlisted provider is configured in
    // Settings → Providers, which is where the runtime actually reads it from.
    if (!args.provider) {
      return yield* fail(
        [
          "providers login needs the provider to log in to.",
          `  nova-cli providers login --provider <id>   (${options.length} available: ${options
            .slice(0, 8)
            .map((x) => x.value)
            .join(", ")}${options.length > 8 ? ", …" : ""})`,
          "  nova-cli providers list                    lists what is already configured",
        ].join("\n"),
        EXIT_USAGE,
      )
    }
    const input = args.provider
    const byID = options.find((x) => x.value === input)
    const byName = options.find((x) => x.label.toLowerCase() === input.toLowerCase())
    const match = byID ?? byName
    if (!match) {
      return yield* fail(`Unknown provider "${input}"`)
    }
    const provider = match.value

    if (provider === "novaclaw") {
      yield* Prompt.log.info("Create an api key at https://novaclaw.app/auth")
    }

    if (provider === "vercel") {
      yield* Prompt.log.info("You can create an api key at https://vercel.link/ai-gateway-token")
    }

    if (["cloudflare", "cloudflare-ai-gateway"].includes(provider)) {
      yield* Prompt.log.info(
        "Cloudflare AI Gateway can be configured with CLOUDFLARE_GATEWAY_ID, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN environment variables. Read more: https://novaclaw.app/docs/providers/#cloudflare-ai-gateway",
      )
    }

    // ⚠️ This was `Prompt.password({message: "Enter your API key"})` with NO non-interactive escape
    // of any kind — the one leaf of the eight that could not be satisfied from argv at all. A
    // scheduled agent or CI job running `providers login --provider openai` got a process that
    // never returned.
    const apiKey = process.env[API_KEY_ENV]?.trim()
    if (!apiKey) {
      return yield* fail(
        [
          `providers login needs the API key for "${provider}" in ${API_KEY_ENV}.`,
          `  ${API_KEY_ENV}=<key> nova-cli providers login --provider ${provider}`,
          "It is read from the environment, never from argv, so the key does not appear in the process list.",
        ].join("\n"),
        EXIT_USAGE,
      )
    }
    yield* Effect.orDie(authSvc.set(provider, { type: "api", key: apiKey }))

    yield* Prompt.outro("Done")
  }),
})

export const ProvidersLogoutCommand = effectCmd({
  command: "logout [provider]",
  describe: "log out from a configured provider",
  builder: (yargs) =>
    yargs.positional("provider", {
      describe: "provider id or name to log out from",
      type: "string",
    }),
  // Removes a global auth credential; no project instance needed.
  instance: false,
  handler: Effect.fn("Cli.providers.logout")(function* (args) {
    const authSvc = yield* Auth.Service
    const modelsDev = yield* ModelsDev.Service

    UI.empty()
    const credentials: Array<[string, Auth.Info]> = Object.entries(yield* Effect.orDie(authSvc.all()))
    yield* Prompt.intro("Remove credential")
    // ⚠️ "No credentials found" then `return` exited 0: `providers logout x && echo ok` printed the
    // error AND "ok". A mutation that did not happen never reports success (ruling 2).
    if (credentials.length === 0) return yield* fail("No credentials found")
    const database = yield* modelsDev.get()
    const options = credentials.map(([key, value]) => ({
      label: (database[key]?.name || key) + UI.Style.TEXT_DIM + " (" + value.type + ")",
      value: key,
    }))
    // ⚠️ Was a `Select provider` autocomplete when the positional was omitted. Refuse and name the
    // credentials that exist instead — the list is the same information the prompt would have shown.
    if (!args.provider) {
      return yield* fail(
        [
          "providers logout needs the provider to log out from.",
          `  nova-cli providers logout <provider>   (stored: ${options.map((x) => x.value).join(", ")})`,
        ].join("\n"),
        EXIT_USAGE,
      )
    }
    const provider = options.find(
      (option) =>
        option.value === args.provider || database[option.value]?.name?.toLowerCase() === args.provider?.toLowerCase(),
    )?.value
    if (!provider) return yield* fail(`Unknown configured provider "${args.provider}"`)
    yield* Effect.orDie(authSvc.remove(provider))
    yield* Prompt.outro("Logout successful")
  }),
})
