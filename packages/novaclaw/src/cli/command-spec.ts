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
    // No `builder` here, and that is a decision rather than an omission. Assigning a GENERIC helper
    // (`withServerOptions<T>(yargs: Argv<T>)`) in this position makes yargs infer `T = unknown`, which
    // quietly drops the concrete option types from the handler's `args`; `cmd/web.ts` declares its
    // builder inline, the way `cmd/serve.ts` does, and infers them properly. One builder per command,
    // declared where its options are actually visible to the type checker.
  },
  models: {
    command: "models [provider]",
    describe: "list all available models",
  },
  export: {
    command: "export [sessionID]",
    describe: "export session data as JSON",
  },
  db: {
    command: "db",
    describe: "database tools",
  },
} as const

export type CommandSpec = (typeof CommandSpec)[keyof typeof CommandSpec]

