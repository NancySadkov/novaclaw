export const CommandSpec = {
  mcp: {
    command: "mcp",
    describe: "manage MCP (Model Context Protocol) servers",
  },
  run: {
    command: "run [message..]",
    describe: "run novaclaw with a message",
  },
  generate: {
    command: "generate",
  },
  debug: {
    command: "debug",
    describe: "debugging and troubleshooting tools",
  },
  providers: {
    command: "providers",
    aliases: ["auth"],
    describe: "manage AI providers and credentials",
  },
  agent: {
    command: "agent",
    describe: "manage agents",
  },
  serve: {
    command: "serve",
    describe: "starts a headless novaclaw server",
  },
  web: {
    command: ["web", "$0"],
    describe: "start novaclaw server and open web interface",
    builder: withNetworkOptions,
  },
  models: {
    command: "models [provider]",
    describe: "list all available models",
  },
  stats: {
    command: "stats",
    describe: "show token usage and cost statistics",
  },
  export: {
    command: "export [sessionID]",
    describe: "export session data as JSON",
  },
  pr: {
    command: "pr <number>",
    describe: "fetch and checkout a GitHub PR branch, then run novaclaw",
  },
  session: {
    command: "session",
    describe: "manage sessions",
  },
  db: {
    command: "db",
    describe: "database tools",
  },
} as const

export type CommandSpec = (typeof CommandSpec)[keyof typeof CommandSpec]
import { withNetworkOptions } from "./network-options"
