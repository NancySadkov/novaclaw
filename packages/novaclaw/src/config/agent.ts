export * as ConfigAgent from "./agent"

import path from "path"
import { Exit, Schema } from "effect"
import { Glob } from "@novaclaw/core/util/glob"
import { ConfigAgent as CoreConfigAgent } from "@novaclaw/core/config/agent"
import { configEntryNameFromPath } from "./entry-name"
import * as ConfigMarkdown from "./markdown"
import { ConfigParse } from "./parse"

// Markdown agents author the canonical V2 `ConfigAgent.Info` frontmatter; the file body is the system
// prompt. There is no V1 flat-frontmatter shape anymore (F1-config).
export async function load(dir: string) {
  const result: Record<string, CoreConfigAgent.Info> = {}
  for (const item of await Glob.scan("{agent,agents}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["agent/", "agents/"])

    const config = {
      ...md.data,
      system: md.content.trim(),
    }
    result[name] = ConfigParse.schema(CoreConfigAgent.Info, config, item)
  }
  return result
}

export async function loadMode(dir: string) {
  const result: Record<string, CoreConfigAgent.Info> = {}
  for (const item of await Glob.scan("{mode,modes}/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["mode/", "modes/"])
    const config = {
      ...md.data,
      system: md.content.trim(),
      mode: "primary" as const,
    }
    const parsed = Schema.decodeUnknownExit(CoreConfigAgent.Info)(config, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(parsed)) {
      result[name] = parsed.value
    }
  }
  return result
}
