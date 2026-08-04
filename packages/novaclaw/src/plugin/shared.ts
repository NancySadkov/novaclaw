import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import npa from "npm-package-arg"
import { Filesystem } from "@/util/filesystem"

// Plugin specifier + path-target resolution for config's plugin-origin dedup (`config/plugin.ts`,
// which feeds the V2 `plugins` key and the `{plugin,plugins}/*` directory walk). That is now the
// ONLY consumer.
//
// Two rounds of removal shrank this module to what it is. The V1 plugin arm — entrypoint
// detection, id resolution, the `engines.novaclaw` compatibility gate and the deprecated-package
// skip list — went with the loader it served. The `novaclaw plugin <module>` install CLI
// (`cli/cmd/plug.ts` + `plugin/install.ts`) and the plugin metadata store (`plugin/meta.ts`) went
// next: the CLI had been a no-op since the v2 config rename (it patched the singular `plugin` key
// while the runtime reads the plural `plugins`), and the meta store had no production callers at
// all. Their exports here — `pluginSource`, `resolvePluginTarget` (the npm-install path) and
// `readPluginPackage` — went with them. V2 plugins resolve their entrypoint through
// `core/config/plugin/external.ts` instead.

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

const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"]

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
