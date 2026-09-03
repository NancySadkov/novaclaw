export * as McpChildEnv from "./child-env"

import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js"

/**
 * The environment a LOCAL MCP server is spawned with.
 *
 * 🔴 Until 2026-09-03 it was `{ ...process.env, ...mcp.environment }`: a third party's program
 * received every variable this instance holds — `NOVACLAW_SERVER_PASSWORD`, provider keys exported
 * in the user's shell, tokens for other tools — while the capability-service spawner in the same
 * directory (`capability-service-worker.ts`) passed only the SDK's default set plus the names the
 * service DECLARED. Two spawners, one directory, opposite postures; the one that talked to strangers
 * had the open one. The data plane never egresses (AGENTS.md principle 4), and an MCP server is a
 * stranger's process by the 2026-07-30 third-party-surface ruling.
 *
 * So: the SDK's default set (`PATH`, `HOME`/`USERPROFILE`, the temp and system variables a process
 * needs to start at all), then what the config DECLARES for that server, and nothing else. A server
 * that needs `FOO` says so in its `environment`; the config is where a person can see what a
 * stranger is given.
 *
 * The one exception is the instance's own CLI acting as an MCP server (`command: ["novaclaw", …]`):
 * it is us, and it needs `NOVACLAW_*` and `XDG_*` to find the same instance home the host runs in.
 * Those prefixes pass through for that command only; a stranger named `novaclaw` in a config file
 * would also get them, which is the config author's own instance and their own call.
 */
export function childEnvironment(input: {
  readonly command: string
  readonly declared?: Readonly<Record<string, string>> | undefined
  readonly parent?: NodeJS.ProcessEnv
}): Record<string, string> {
  const parent = input.parent ?? process.env
  const env: Record<string, string> = { ...getDefaultEnvironment() }
  if (input.command === "novaclaw") {
    env.BUN_BE_BUN = "1"
    for (const [name, value] of Object.entries(parent)) {
      if (value === undefined) continue
      if (name.startsWith("NOVACLAW_") || name.startsWith("XDG_")) env[name] = value
    }
  }
  for (const [name, value] of Object.entries(input.declared ?? {})) env[name] = value
  return env
}
