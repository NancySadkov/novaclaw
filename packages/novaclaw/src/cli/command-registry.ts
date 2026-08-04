import { CommandSpec } from "./command-spec"
import { lazyCommand } from "./lazy-command"

export const McpCommand = lazyCommand({
  ...CommandSpec.mcp,
  async load() {
    const { McpCommand } = await import("./cmd/mcp")
    return McpCommand
  },
})

export const RunCommand = lazyCommand({
  ...CommandSpec.run,
  async load() {
    const { RunCommand } = await import("./cmd/run")
    return RunCommand
  },
})

export const GenerateCommand = lazyCommand({
  ...CommandSpec.generate,
  async load() {
    const { GenerateCommand } = await import("./cmd/generate")
    return GenerateCommand
  },
})

export const DebugCommand = lazyCommand({
  ...CommandSpec.debug,
  async load() {
    const { DebugCommand } = await import("./cmd/debug")
    return DebugCommand
  },
})

export const ProvidersCommand = lazyCommand({
  ...CommandSpec.providers,
  async load() {
    const { ProvidersCommand } = await import("./cmd/providers")
    return ProvidersCommand
  },
})

export const AgentCommand = lazyCommand({
  ...CommandSpec.agent,
  async load() {
    const { AgentCommand } = await import("./cmd/agent")
    return AgentCommand
  },
})

export const ServeCommand = lazyCommand({
  ...CommandSpec.serve,
  async load() {
    const { ServeCommand } = await import("./cmd/serve")
    return ServeCommand
  },
})

export const WebCommand = lazyCommand({
  ...CommandSpec.web,
  async load() {
    const { WebCommand } = await import("./cmd/web")
    return WebCommand
  },
})

export const ModelsCommand = lazyCommand({
  ...CommandSpec.models,
  async load() {
    const { ModelsCommand } = await import("./cmd/models")
    return ModelsCommand
  },
})

export const StatsCommand = lazyCommand({
  ...CommandSpec.stats,
  async load() {
    const { StatsCommand } = await import("./cmd/stats")
    return StatsCommand
  },
})

export const ExportCommand = lazyCommand({
  ...CommandSpec.export,
  async load() {
    const { ExportCommand } = await import("./cmd/export")
    return ExportCommand
  },
})

export const PrCommand = lazyCommand({
  ...CommandSpec.pr,
  async load() {
    const { PrCommand } = await import("./cmd/pr")
    return PrCommand
  },
})

export const SessionCommand = lazyCommand({
  ...CommandSpec.session,
  async load() {
    const { SessionCommand } = await import("./cmd/session")
    return SessionCommand
  },
})

export const DbCommand = lazyCommand({
  ...CommandSpec.db,
  async load() {
    const { DbCommand } = await import("./cmd/db")
    return DbCommand
  },
})
