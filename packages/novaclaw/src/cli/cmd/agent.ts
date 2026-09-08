import { cmd } from "./cmd"
import { UI } from "../ui"
import { Global } from "@novaclaw/core/global"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "@/util/filesystem"
import matter from "gray-matter"
import { EOL } from "os"
import type { Argv } from "yargs"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { CommandSpec } from "../command-spec"

type AgentMode = "all" | "primary" | "subagent"

const AgentListCommand = effectCmd({
  command: "list",
  describe: "list all available agents",
  // Lists the authoritative V2 agent store (incl. plugin-registered agents),
  // projected onto the V1 shape. Resolves the location-scoped `AgentV2` for the
  // cwd via the core location-service map (cf. cli/cmd/debug/v2.ts) — no instance.
  instance: false,
  handler: Effect.fn("Cli.agent.list")(function* () {
    const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
    const { LocationServiceMap, locationServiceMapLayer } = yield* Effect.promise(
      () => import("@novaclaw/core/location-services"),
    )
    const { Location } = yield* Effect.promise(() => import("@novaclaw/core/location"))
    const { AbsolutePath } = yield* Effect.promise(() => import("@novaclaw/core/schema"))
    const agents = yield* Agent.listV2.pipe(
      Effect.provide(
        LocationServiceMap.Service.get(Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })),
      ),
      Effect.provide(locationServiceMapLayer),
    )
    const sortedAgents = agents.sort((a, b) => {
      if (a.native !== b.native) {
        return a.native ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    for (const agent of sortedAgents) {
      process.stdout.write(`${agent.name} (${agent.mode})` + EOL)
      process.stdout.write(`  ${JSON.stringify(agent.permission, null, 2)}` + EOL)
    }
  }),
})

export const AgentCommand = cmd({
  ...CommandSpec.agent,
  builder: (yargs) => yargs.command(AgentListCommand).demandCommand(),
  async handler() {},
})
