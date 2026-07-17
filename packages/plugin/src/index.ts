import type { NovaclawClient, ConfigInfo } from "@novaclaw/sdk/v2/client"
import type { ModelV2Info, Auth } from "@novaclaw/sdk/v2"

import type { BunShell } from "./shell.js"

export * from "./tool.js"

// V1-nuke slice B (2026-07-17): this surface is typed against the NATIVE V2 sdk and carries ONLY
// the hooks the host actually fires. The V1-era hook set (chat.message, chat.params/headers,
// permission.ask, tool.execute.before/after, command.execute.before, tool.definition, the
// experimental compaction/text/messages/small_model family, the Hooks.tool dict, AuthHook.loader,
// ProviderHook) was declared but NEVER dispatched anywhere in the tree — deleted outright, no
// deprecation window (pre-release). The V2 effect-based plugin system lives in ./v2; this module
// remains the SERVER plugin surface (event fan-out, config, auth methods, shell.env, the
// system-prompt transform, workspace adapters, and shared tool definitions).

export type WorkspaceInfo = {
  id: string
  type: string
  name: string
  branch: string | null
  directory: string | null
  extra: unknown | null
  origin: string
}

export type WorkspaceTarget =
  | {
      type: "local"
      directory: string
    }
  | {
      type: "remote"
      url: string | URL
      headers?: HeadersInit
    }

export type WorkspaceAdapter = {
  name: string
  description: string
  configure(config: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>
  create(config: WorkspaceInfo, env: Record<string, string | undefined>, from?: WorkspaceInfo): Promise<void>
  remove(config: WorkspaceInfo): Promise<void>
  target(config: WorkspaceInfo): WorkspaceTarget | Promise<WorkspaceTarget>
}

export type PluginInput = {
  /** The NATIVE client (the /api surface — the same client the app uses). */
  client: NovaclawClient
  /** T3 (entities.md): the rename-stable origin hash of the repo (no project entity). */
  origin: string
  directory: string
  worktree: string
  experimental_workspace: {
    register(type: string, adapter: WorkspaceAdapter): void
  }
  serverUrl: URL
  $: BunShell
}

export type PluginOptions = Record<string, unknown>

export type Config = Omit<ConfigInfo, "plugin"> & {
  plugin?: Array<string | [string, PluginOptions]>
}

export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>

export type PluginModule = {
  id?: string
  server: Plugin
  tui?: never
}

type Rule = {
  key: string
  op: "eq" | "neq"
  value: string
}

export type AuthHook = {
  provider: string
  methods: (
    | {
        type: "oauth"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              when?: Rule
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{
                label: string
                value: string
                hint?: string
              }>
              when?: Rule
            }
        >
        authorize(inputs?: Record<string, string>): Promise<AuthOAuthResult>
      }
    | {
        type: "api"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              when?: Rule
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{
                label: string
                value: string
                hint?: string
              }>
              when?: Rule
            }
        >
        authorize?(inputs?: Record<string, string>): Promise<
          | {
              type: "success"
              key: string
              provider?: string
              metadata?: Record<string, string>
            }
          | {
              type: "failed"
            }
        >
      }
  )[]
}

export type AuthOAuthResult = { url: string; instructions: string } & (
  | {
      method: "auto"
      callback(): Promise<
        | ({
            type: "success"
            provider?: string
          } & (
            | {
                refresh: string
                access: string
                expires: number
                accountId?: string
              }
            | { key: string; metadata?: Record<string, string> }
          ))
        | {
            type: "failed"
          }
      >
    }
  | {
      method: "code"
      callback(code: string): Promise<
        | ({
            type: "success"
            provider?: string
          } & (
            | {
                refresh: string
                access: string
                expires: number
                accountId?: string
              }
            | { key: string; metadata?: Record<string, string> }
          ))
        | {
            type: "failed"
          }
      >
    }
)

/** The raw durable-event fan-out shape the host sends (native V2 events, untranslated). */
export type PluginEvent = {
  id: string
  type: string
  properties: unknown
}

export interface Hooks {
  dispose?: () => Promise<void>
  /** Every durable event for the plugin's directory, in the NATIVE vocabulary. */
  event?: (input: { event: PluginEvent }) => Promise<void>
  config?: (input: Config) => Promise<void>
  auth?: AuthHook
  /** Contribute environment variables to spawned shells (ptys + shell tools). */
  "shell.env"?: (
    input: { cwd: string; sessionID?: string; callID?: string },
    output: { env: Record<string, string> },
  ) => Promise<void>
  /** Customize the agent-generation system prompt. */
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string; model: ModelV2Info },
    output: {
      system: string[]
    },
  ) => Promise<void>
}

// Re-export the auth credential shape plugins receive.
export type { Auth }
