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

/**
 * ⚠️ LISTING ONLY since 2026-09-03. `providers login` typed a secret through `Prompt.password` and
 * `providers logout` picked one from a list: interactive credential management, on a surface
 * principle 7 says is vestigial and headless-only. Connecting a provider is Settings → Providers,
 * which is the one place that flow lives. What remains reports what is connected, which is what a
 * headless machine and a support conversation actually need.
 */
export const ProvidersCommand = cmd({
  ...CommandSpec.providers,
  builder: (yargs) => yargs.command(ProvidersListCommand).demandCommand(),
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
