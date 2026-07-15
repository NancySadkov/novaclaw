export * as ConfigCommandPlugin from "./command"

import { define } from "../../plugin/internal"
import type { PluginContext } from "@novaclaw/plugin/v2/effect"
import path from "path"
import { Effect, Option, Schema } from "effect"
import { CommandConfigStore } from "../../command-config-store"
import { Config } from "../../config"
import { FSUtil } from "../../fs-util"
import { ModelV2 } from "../../model"
import { ConfigCommand } from "../command"
import { ConfigMarkdown } from "../markdown"

const decodeCommand = Schema.decodeUnknownOption(ConfigCommand.Info)
/** The plugin-facing command draft (what ctx.command.transform hands its callback). */
type CommandDraft = Parameters<Parameters<PluginContext["command"]["transform"]>[0]>[0]

// Config→SQLite step 3: config-FILE command definitions come from the instance-wide
// `CommandConfigStore` (ordered layers per command), not from `config.entries()`. Markdown
// commands stay filesystem-walked (locked decision D2 — user-editable documents, not settings).
export const Plugin = define({
  id: "config-command",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const store = yield* CommandConfigStore.Service
    const fs = yield* FSUtil.Service
    yield* ctx.command.transform(
      Effect.fn(function* (draft) {
        const entries = yield* config.entries()

        // Config-borne commands from the store (each command's layers apply in order)…
        const stored = yield* store.commands()
        for (const [name, layers] of Object.entries(stored)) for (const item of layers) applyItem(draft, name, item)

        // …then the markdown commands (full definitions; a name collision lets the file win).
        for (const entry of entries) {
          if (entry.type === "document") continue
          const commands = yield* loadDirectory(fs, entry.path)
          for (const command of commands) applyItem(draft, command.name, command.info)
        }
      }),
    )
  }),
})

/** Apply ONE config fragment for one command onto the draft (the historical per-document merge body). */
function applyItem(draft: CommandDraft, name: string, command: ConfigCommand.Info) {
  draft.update(name, (item) => {
    item.template = command.template
    if (command.description !== undefined) item.description = command.description
    if (command.agent !== undefined) item.agent = command.agent
    if (command.model !== undefined) {
      const model = ModelV2.parse(command.model)
      item.model = { id: model.modelID, providerID: model.providerID, variant: item.model?.variant }
    }
    if (command.variant !== undefined && item.model !== undefined) {
      item.model.variant = ModelV2.VariantID.make(command.variant)
    }
    if (command.subtask !== undefined) item.subtask = command.subtask
  })
}

function loadDirectory(fs: FSUtil.Interface, directory: string) {
  return Effect.gen(function* () {
    const files = yield* fs
      .glob("{command,commands}/**/*.md", { cwd: directory, absolute: true, dot: true, symlink: true })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    return yield* Effect.forEach(files.toSorted(), (filepath) =>
      fs.readFileStringSafe(filepath).pipe(
        Effect.map((content) => (content === undefined ? undefined : decode(directory, filepath, content))),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
    ).pipe(
      Effect.map((commands) =>
        commands.filter((command): command is { name: string; info: ConfigCommand.Info } => command !== undefined),
      ),
    )
  })
}

function decode(directory: string, filepath: string, content: string) {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return
  const info = Option.getOrUndefined(decodeCommand({ ...markdown.data, template: markdown.content.trim() }))
  if (!info) return
  return {
    name: path
      .relative(directory, filepath)
      .replaceAll("\\", "/")
      .replace(/^(command|commands)\//, "")
      .replace(/\.md$/, ""),
    info,
  }
}
