export * as ConfigAgentPlugin from "./agent"

import { define } from "../../plugin/internal"
import type { PluginContext } from "@novaclaw/plugin/v2/effect"
import path from "path"
import { Effect, Option, Schema } from "effect"
import { AgentV2 } from "../../agent"
import { AgentConfigStore } from "../../agent-config-store"
import { Config } from "../../config"
import { ConfigAgent } from "../agent"
import { ConfigMarkdown } from "../markdown"
import { FSUtil } from "../../fs-util"
import { ModelV2 } from "../../model"
import type { Permission } from "@novaclaw/schema/permission"

const markdownSources = [
  { pattern: "{agent,agents}/**/*.md", primary: false },
  { pattern: "{mode,modes}/*.md", primary: true },
] as const
/** The plugin-facing agent draft (what ctx.agent.transform hands its callback). */
type AgentDraft = Parameters<Parameters<PluginContext["agent"]["transform"]>[0]>[0]
const decodeAgent = Schema.decodeUnknownOption(ConfigAgent.Info)
const decodeConfig = Schema.decodeUnknownOption(Config.Info)

// Config→SQLite steps 2 + 8c: config-borne agent definitions come from the instance-wide
// `AgentConfigStore` (ordered layers per agent) — so every location (incl. the shared scratch
// dir) resolves the same agents. Markdown agents stay filesystem-walked (locked decision D2 —
// user-editable documents, not settings). The global `permissions` ruleset reads from the
// settings store's synthetic document (the only document post-8c).
export const Plugin = define({
  id: "config-agent",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const store = yield* AgentConfigStore.Service
    const fs = yield* FSUtil.Service
    yield* ctx.agent.transform(
      Effect.fn(function* (draft) {
        const entries = yield* config.entries()
        const files = entries.filter((entry): entry is Config.Document => entry.type === "document")
        // D2: walk the markdown agent/mode files exactly as before (their filenames are the names).
        const markdownDocuments = yield* Effect.forEach(entries, (entry) => {
          if (entry.type === "document") return Effect.succeed([])
          return Effect.gen(function* () {
            const found = yield* discover(fs, entry.path)
            return yield* Effect.forEach(found, (file) =>
              fs.readFileStringSafe(file.filepath).pipe(
                Effect.map((content) => content && decode(file, content)),
                Effect.catch(() => Effect.succeed(undefined)),
              ),
            ).pipe(
              Effect.map((documents) =>
                documents.filter((document): document is Config.Document => document !== undefined),
              ),
            )
          })
        }).pipe(Effect.map((documents) => documents.flat()))

        const global = files.flatMap((file) => file.info.permissions ?? [])
        const storedDefault = yield* store.getDefault()
        if (storedDefault !== undefined) draft.default(AgentV2.ID.make(storedDefault))
        for (const current of draft.list()) {
          draft.update(current.id, (agent) => agent.permissions.push(...global))
        }

        // Config-borne agents from the store (each agent's layers apply in order)…
        const stored = yield* store.agents()
        for (const [name, layers] of Object.entries(stored))
          for (const item of layers) applyItem(draft, AgentV2.ID.make(name), item, global)
        // …then the markdown agents (full definitions; a name collision lets the file win).
        for (const document of markdownDocuments)
          for (const [name, item] of Object.entries(document.info.agents ?? {}))
            applyItem(draft, AgentV2.ID.make(name), item, global)
      }),
    )
  }),
})

/** Apply ONE config fragment for one agent onto the draft (the historical per-document merge body). */
function applyItem(draft: AgentDraft, agentID: AgentV2.ID, item: ConfigAgent.Info, global: Permission.Ruleset) {
  if (item.disabled) {
    draft.remove(agentID)
    return
  }

  const exists = draft.get(agentID) !== undefined
  draft.update(agentID, (agent) => {
    if (!exists) agent.permissions.push(...global)
    if (item.model !== undefined) {
      const model = ModelV2.parse(item.model)
      agent.model = { id: model.modelID, providerID: model.providerID, variant: agent.model?.variant }
    }
    if (item.variant !== undefined && agent.model !== undefined) {
      agent.model.variant = ModelV2.VariantID.make(item.variant)
    }
    if (item.request !== undefined) {
      Object.assign(agent.request.headers, item.request.headers ?? {})
      Object.assign(agent.request.body, item.request.body ?? {})
    }
    if (item.system !== undefined) agent.system = item.system
    if (item.description !== undefined) agent.description = item.description
    if (item.mode !== undefined) agent.mode = item.mode
    if (item.hidden !== undefined) agent.hidden = item.hidden
    if (item.color !== undefined) agent.color = item.color
    if (item.steps !== undefined) agent.steps = item.steps
    if (item.permissions !== undefined) agent.permissions.push(...item.permissions)
  })
}

function discover(fs: FSUtil.Interface, directory: string) {
  return Effect.forEach(markdownSources, (source) =>
    fs
      .glob(source.pattern, { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(
        Effect.map((files) => files.toSorted().map((filepath) => ({ directory, filepath, primary: source.primary }))),
      ),
  ).pipe(
    Effect.map((files) => files.flat()),
    Effect.catch(() => Effect.succeed([])),
  )
}

function decode(file: { directory: string; filepath: string; primary: boolean }, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  const name = path
    .relative(file.directory, file.filepath)
    .replaceAll("\\", "/")
    .replace(/^(agent|agents|mode|modes)\//, "")
    .replace(/\.md$/, "")
  const body = markdown.content.trim()
  // Markdown agents are authored with canonical `ConfigAgent` frontmatter keys; the file body is the
  // system prompt. Frontmatter carrying any unknown key fails to decode and the agent is skipped.
  const agent = Option.getOrUndefined(
    decodeAgent({ ...markdown.data, system: body }, { errors: "all", propertyOrder: "original" }),
  )
  if (!agent) return
  const info = Option.getOrUndefined(
    decodeConfig({
      agents: { [name]: file.primary ? { ...agent, mode: "primary" } : agent },
    }),
  )
  if (!info) return
  return new Config.Document({ type: "document", path: file.filepath, info })
}
