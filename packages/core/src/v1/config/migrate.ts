export * as ConfigMigrateV1 from "./migrate"

import { ConfigV1 } from "./config"
import { ConfigAgentV1 } from "./agent"
import { ConfigMCPV1 } from "./mcp"
import { ConfigPermissionV1 } from "./permission"
import { ConfigProviderV1 } from "./provider"
import { ConfigProviderOptionsV1 } from "./provider-options"

// V1-ONLY top-level keys: their presence means a file was authored against the V1 schema and
// must be run through migrate() before decoding as V2. A key belongs here iff it exists in
// ConfigV1.Info but NOT in the V2 Config.Info (either dropped, or spelled differently in V2).
// ⚠️ F1d TRAP: `server`, `disabled_providers`, `enabled_providers` were promoted into V2
// (D1/D2) — they are now V2-native, so they LEFT this set. A V2 file carrying `server:` must
// not be re-migrated. `autoshare` also left: the share feature is gone (④), so it is no longer
// a ConfigV1.Info key. The rest below are V1-only because V2 renames them (command→commands,
// reference→references, snapshot→snapshots, plugin→plugins, mode/agent→agents,
// provider→providers, permission→permissions, attachment→attachments) or drops them
// (logLevel, small_model, layout — see DROPPED).
const keys = new Set([
  "logLevel",
  "command",
  "reference",
  "snapshot",
  "plugin",
  "small_model",
  "mode",
  "agent",
  "provider",
  "permission",
  "tools",
  "attachment",
  "layout",
])

// V1 top-level keys intentionally NOT carried into V2 (F1d D3/D4): logging is env/flag-driven
// (`logLevel`); layout is dead (always stretch); `small_model`'s only reader was the V1
// provider `getSmallModel`, dead residue post-F1b. The V2 loader decodes with
// `onExcessProperty: "ignore"`, so these fall away on read — no active deletion needed. The
// config key-coverage guard test asserts this list stays exhaustive against ConfigV1.Info.
export const DROPPED = ["logLevel", "small_model", "layout"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Some fields keep their V1 NAME in V2 but changed SHAPE, so key-presence alone can't tell V1 from V2.
// Detect a V1-shaped value for each:
//  - `mcp`: V1 is a flat `{ <serverName>: … }` record; V2 nests everything under `timeout`/`servers`.
//  - `compaction`: `preserve_recent_tokens`/`reserved` are V1-only (V2 spells them `keep.tokens`/`buffer`).
//  - `skills`: V1 is `{ paths, urls }` (an object); V2 is a flat `string[]`.
//  - `experimental`: V1 carries `mcp_timeout`/`batch_tool`/… ; V2 keeps only `policies`.
function hasV1ShapedField(input: Record<string, unknown>) {
  const { mcp, compaction, skills, experimental } = input
  if (isRecord(mcp) && Object.keys(mcp).some((key) => key !== "timeout" && key !== "servers")) return true
  if (isRecord(compaction) && ("preserve_recent_tokens" in compaction || "reserved" in compaction)) return true
  if (isRecord(skills)) return true
  if (isRecord(experimental) && Object.keys(experimental).some((key) => key !== "policies")) return true
  return false
}

export function isV1(input: unknown) {
  if (!isRecord(input)) return false
  return Object.keys(input).some((key) => keys.has(key)) || hasV1ShapedField(input)
}

export function migrate(info: typeof ConfigV1.Info.Type) {
  return {
    $schema: info.$schema,
    shell: info.shell,
    model: info.model,
    default_agent: info.default_agent,
    autoupdate: info.autoupdate,
    username: info.username,
    // Promoted into V2 verbatim (F1d D1/D2) — carried through unchanged.
    server: info.server,
    disabled_providers: info.disabled_providers,
    enabled_providers: info.enabled_providers,
    permissions: permissions(info.permission, info.tools),
    agents: agents(info),
    snapshots: info.snapshot,
    watcher: info.watcher,
    formatter: info.formatter,
    attachments: info.attachment,
    tool_output: info.tool_output,
    mcp: mcp(info),
    persona: info.persona,
    user_profile: info.user_profile,
    introspection: info.introspection,
    adhoc_tools: info.adhoc_tools,
    affective: info.affective,
    offline: info.offline,
    kb: info.kb,
    quality: info.quality,
    compaction: info.compaction && {
      auto: info.compaction.auto,
      prune: info.compaction.prune,
      keep: {
        tokens: info.compaction.preserve_recent_tokens,
      },
      buffer: info.compaction.reserved,
    },
    skills: info.skills && [...(info.skills.paths ?? []), ...(info.skills.urls ?? [])],
    commands: info.command,
    instructions: info.instructions,
    references: info.references ?? info.reference,
    plugins: info.plugin?.map((plugin) =>
      typeof plugin === "string" ? plugin : { package: plugin[0], options: plugin[1] },
    ),
    experimental: info.experimental?.policies && { policies: info.experimental.policies },
    providers: providers(info.provider),
  }
}

function permissions(info?: ConfigPermissionV1.Info, tools?: Readonly<Record<string, boolean>>) {
  const rules: Array<{ action: string; resource: string; effect: ConfigPermissionV1.Action }> = Object.entries(
    tools ?? {},
  ).map(([action, enabled]) => ({
    action: normalizeAction(action),
    resource: "*",
    effect: enabled ? ("allow" as const) : ("deny" as const),
  }))
  for (const [action, rule] of Object.entries(info ?? {})) {
    if (!rule) continue
    if (typeof rule === "string") {
      rules.push({ action, resource: "*", effect: rule })
      continue
    }
    rules.push(...Object.entries(rule).map(([resource, effect]) => ({ action, resource, effect })))
  }
  return rules.length ? rules : undefined
}

function normalizeAction(action: string) {
  return action === "write" || action === "patch" ? "edit" : action
}

function agents(info: typeof ConfigV1.Info.Type) {
  const entries = [
    ...Object.entries(info.agent ?? {}),
    ...Object.entries(info.mode ?? {}).map(([name, agent]) => [name, { ...agent, mode: "primary" as const }] as const),
  ]
  if (!entries.length) return undefined
  return Object.fromEntries(entries.flatMap(([name, agent]) => (agent ? [[name, migrateAgent(agent)]] : [])))
}

export function migrateAgent(info: ConfigAgentV1.Info) {
  const body = {
    ...info.options,
    ...(info.temperature === undefined ? {} : { temperature: info.temperature }),
    ...(info.top_p === undefined ? {} : { top_p: info.top_p }),
  }
  return {
    model: info.model,
    variant: info.variant,
    request: Object.keys(body).length ? { body } : undefined,
    system: info.prompt,
    description: info.description,
    mode: info.mode,
    hidden: info.hidden,
    color: info.color,
    steps: info.steps,
    disabled: info.disable,
    permissions: permissions(info.permission),
  }
}

function mcp(info: typeof ConfigV1.Info.Type) {
  const servers = Object.fromEntries(
    Object.entries(info.mcp ?? {}).flatMap(([name, server]) =>
      "type" in server ? [[name, migrateMcp(server)] as const] : [],
    ),
  )
  const timeout = info.experimental?.mcp_timeout
  if (!timeout && !Object.keys(servers).length) return undefined
  return { timeout: timeout === undefined ? undefined : { request: timeout }, servers }
}

function migrateMcp(info: ConfigMCPV1.Info) {
  const disabled = info.enabled === undefined ? undefined : !info.enabled
  if (info.type === "local")
    return {
      type: info.type,
      command: info.command,
      cwd: info.cwd,
      environment: info.environment,
      disabled,
      timeout: info.timeout === undefined ? undefined : { request: info.timeout },
    }
  return {
    type: info.type,
    url: info.url,
    headers: info.headers,
    oauth: info.oauth && {
      client_id: info.oauth.clientId,
      client_secret: info.oauth.clientSecret,
      scope: info.oauth.scope,
      callback_port: info.oauth.callbackPort,
      redirect_uri: info.oauth.redirectUri,
    },
    disabled,
    timeout: info.timeout === undefined ? undefined : { request: info.timeout },
  }
}

function providers(info?: Readonly<Record<string, ConfigProviderV1.Info>>) {
  if (!info) return undefined
  return Object.fromEntries(Object.entries(info).map(([name, provider]) => [name, migrateProvider(provider)]))
}

function migrateProvider(info: ConfigProviderV1.Info) {
  const lowerer = ConfigProviderOptionsV1.get(info.npm)
  const options = lowerer.provider(info.options ?? {})
  const url = info.api ?? options.url
  return {
    name: info.name,
    env: info.env,
    api: info.npm
      ? {
          type: "aisdk" as const,
          package: info.npm,
          ...(url === undefined ? {} : { url }),
          settings: options.settings ?? {},
        }
      : undefined,
    request: info.options && { headers: options.headers, body: options.body },
    models:
      info.models &&
      Object.fromEntries(Object.entries(info.models).map(([name, model]) => [name, migrateModel(model, info.npm)])),
  }
}

function migrateModel(info: typeof ConfigProviderV1.Model.Type, packageName?: string) {
  const packageID = info.provider?.npm ?? packageName
  const lowerer = ConfigProviderOptionsV1.get(packageID)
  const request = info.options && lowerer.request(info.options)
  const costs = info.cost && [
    {
      input: info.cost.input,
      output: info.cost.output,
      cache: { read: info.cost.cache_read, write: info.cost.cache_write },
    },
    ...(info.cost.context_over_200k
      ? [
          {
            tier: { type: "context" as const, size: 200_000 },
            input: info.cost.context_over_200k.input,
            output: info.cost.context_over_200k.output,
            cache: { read: info.cost.context_over_200k.cache_read, write: info.cost.context_over_200k.cache_write },
          },
        ]
      : []),
  ]
  const capabilities =
    info.tool_call !== undefined || info.modalities?.input !== undefined || info.modalities?.output !== undefined
      ? { tools: info.tool_call ?? false, input: info.modalities?.input ?? [], output: info.modalities?.output ?? [] }
      : undefined
  return {
    family: info.family,
    name: info.name,
    api: info.provider?.npm
      ? {
          ...(info.id === undefined ? {} : { id: info.id }),
          type: "aisdk" as const,
          package: info.provider.npm,
          ...(info.provider.api === undefined ? {} : { url: info.provider.api }),
          settings: {},
        }
      : info.id === undefined
        ? undefined
        : { id: info.id },
    capabilities,
    request: (info.headers || request) && {
      headers: info.headers,
      body: request,
    },
    variants:
      info.variants &&
      Object.entries(info.variants).map(([id, options]) => ({
        id,
        body: lowerer.request(options),
      })),
    cost: costs,
    disabled: info.status === "deprecated" ? true : undefined,
    limit: info.limit && {
      context: int(info.limit.context),
      input: info.limit.input === undefined ? undefined : int(info.limit.input),
      output: int(info.limit.output),
    },
  }
}

function int(value: number) {
  return Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)))
}
