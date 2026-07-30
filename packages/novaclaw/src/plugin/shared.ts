import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import npa from "npm-package-arg"
import { Filesystem } from "@/util/filesystem"
import { Npm } from "@novaclaw/core/npm"

// Plugin specifier + target resolution shared by the `novaclaw plugin` CLI (`plugin/install.ts`),
// the plugin metadata store (`plugin/meta.ts`), and config's plugin-origin dedup
// (`config/plugin.ts`, which feeds the V2 `plugins` key). The V1 plugin arm that also used this
// module — entrypoint detection, id resolution, the `engines.novaclaw` compatibility gate and the
// deprecated-package skip list — was deleted along with the loader it served; V2 plugins resolve
// their entrypoint through `core/config/plugin/external.ts` instead.

function parse(spec: string) {
  try {
    return npa(spec)
  } catch {}
}

export function parsePluginSpecifier(spec: string) {
  const hit = parse(spec)
  if (hit?.type === "alias" && !hit.name) {
    const sub = (hit as npa.AliasResult).subSpec
    if (sub?.name) {
      const version = !sub.rawSpec || sub.rawSpec === "*" ? "latest" : sub.rawSpec
      return { pkg: sub.name, version }
    }
  }
  if (!hit?.name) return { pkg: spec, version: "" }
  if (hit.raw === hit.name) return { pkg: hit.name, version: "latest" }
  return { pkg: hit.name, version: hit.rawSpec }
}

export type PluginSource = "file" | "npm"

export type PluginPackage = {
  dir: string
  pkg: string
  json: Record<string, unknown>
}

const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"]

export function pluginSource(spec: string): PluginSource {
  if (isPathPluginSpec(spec)) return "file"
  return "npm"
}

function isAbsolutePath(raw: string) {
  return path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)
}

async function resolveDirectoryIndex(dir: string) {
  for (const name of INDEX_FILES) {
    const file = path.join(dir, name)
    if (await Filesystem.exists(file)) return file
  }
}

export function isPathPluginSpec(spec: string) {
  return spec.startsWith("file://") || spec.startsWith(".") || isAbsolutePath(spec)
}

export async function resolvePathPluginTarget(spec: string) {
  const raw = spec.startsWith("file://") ? fileURLToPath(spec) : spec
  const file = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) ? raw : path.resolve(raw)
  const stat = await Filesystem.statAsync(file)
  if (!stat?.isDirectory()) {
    if (spec.startsWith("file://")) return spec
    return pathToFileURL(file).href
  }

  if (await Filesystem.exists(path.join(file, "package.json"))) {
    return pathToFileURL(file).href
  }

  const index = await resolveDirectoryIndex(file)
  if (index) return pathToFileURL(index).href

  throw new Error(`Plugin directory ${file} is missing package.json or index file`)
}

export async function resolvePluginTarget(spec: string) {
  if (isPathPluginSpec(spec)) return resolvePathPluginTarget(spec)
  const hit = parse(spec)
  const pkg = hit?.name && hit.raw === hit.name ? `${hit.name}@latest` : spec
  const result = await Npm.add(pkg)
  return result.directory
}

export async function readPluginPackage(target: string): Promise<PluginPackage> {
  const file = target.startsWith("file://") ? fileURLToPath(target) : target
  const stat = await Filesystem.statAsync(file)
  const dir = stat?.isDirectory() ? file : path.dirname(file)
  const pkg = path.join(dir, "package.json")
  const json = await Filesystem.readJson<Record<string, unknown>>(pkg)
  return { dir, pkg, json }
}
