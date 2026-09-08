import { ConfigPluginGlob } from "@novaclaw/core/config/plugin/glob"
import { Global } from "@novaclaw/core/global"
import { InstallationChannel, InstallationVersion } from "@novaclaw/core/installation/version"
import { DatabasePath } from "@novaclaw/core/database/db-path"
import { Flag } from "@novaclaw/core/flag/flag"
import os from "os"
import { Duration, Effect } from "effect"
import { effectCmd } from "../../effect-cmd"
import { cmd } from "../cmd"
import { ConfigCommand } from "./config"
import { SkillCommand } from "./skill"
import { AgentCommand } from "./agent"
import { StartupCommand } from "./startup"
import { V2Command } from "./v2"
import { CommandSpec } from "../../command-spec"

/**
 * ⚠️ THREE LEAVES LEFT on 2026-09-03, and the reason is principle 7: the CLI is vestigial and
 * headless-only, so a leaf that reimplements something the shell already does is a second product
 * surface with a second set of bugs. `debug rg` and `debug file` were a search-and-browse console
 * (`rg files|search`, `file search|read|list`) over the same engines the Files and Search surfaces
 * use; `debug wait` slept for a day. What stays is the diagnostic set — `info`, `paths`, `config`,
 * `v2`, `startup`, `skill`, `agent` — which reports state rather than operating on it, and which a
 * support conversation needs from a machine with no window open.
 */
export const DebugCommand = cmd({
  ...CommandSpec.debug,
  builder: (yargs) =>
    yargs
      .command(ConfigCommand)
      .command(SkillCommand)
      .command(StartupCommand)
      .command(AgentCommand)
      .command(V2Command)
      .command(InfoCommand)
      .command(PathsCommand)
      .demandCommand(),
  async handler() {},
})

const InfoCommand = effectCmd({
  command: "info",
  describe: "show debug information",
  handler: Effect.fn("Cli.debug.info")(function* () {
    const termProgram = process.env.TERM_PROGRAM
      ? `${process.env.TERM_PROGRAM}${process.env.TERM_PROGRAM_VERSION ? ` ${process.env.TERM_PROGRAM_VERSION}` : ""}`
      : undefined
    const terminal = [termProgram, process.env.TERM].filter((item): item is string => Boolean(item)).join(" / ")

    console.log(`novaclaw version: ${InstallationVersion}`)
    // Which STORE this process is on — principle 12(d), say what is in force. A from-source run is
    // channel `local` and reads `novaclaw-local.db`; the packaged app reads `novaclaw.db`. Two stores,
    // two provider catalogs, and until 2026-09-03 nothing the CLI printed said which one it was on
    // while its own model-not-found message told the user to compare them.
    console.log(`channel: ${InstallationChannel}`)
    console.log(`database: ${DatabasePath.path()}`)
    console.log(`os: ${os.type()} ${os.release()} ${os.arch()}`)
    console.log(`terminal: ${terminal || "unknown"}`)
    // ⚠️ This used to print `config.plugins`. Ruling 5 / step 17 deleted that key — an external
    // plugin is no longer a config VALUE — so the honest answer is the same filesystem walk the
    // loader itself performs (`core/src/config/plugin/external.ts`): `{plugin,plugins}/*.{ts,js}`
    // under the INSTANCE CONFIG DIR, and nowhere else. Printing the directory it looked in is the
    // point when the answer is "none": principle 12(d), say what is in force right now.
    // `Global.make()` rather than `Global.Path`: it is what applies `NOVACLAW_CONFIG_DIR`, and this
    // line must name the directory the LOADER reads, not the default one.
    const configDir = Global.make().config
    console.log(`plugins (${configDir}):`)
    if (Flag.NOVACLAW_PURE) {
      console.log("external plugins disabled (--pure)")
      return
    }
    const files = yield* Effect.promise(() =>
      Array.fromAsync(new Bun.Glob(ConfigPluginGlob.PATTERN).scan({ cwd: configDir, absolute: true, dot: true })).catch(
        () => [] as string[],
      ),
    )
    if (files.length === 0) {
      console.log("none")
      return
    }
    for (const file of files.sort()) console.log(`- ${file}`)
  }),
})

const PathsCommand = cmd({
  command: "paths",
  describe: "show global paths (data, config, cache, state)",
  handler() {
    for (const [key, value] of Object.entries(Global.Path)) {
      console.log(key.padEnd(10), value)
    }
  },
})
