import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { posix, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import policy from "../../script/lib/build-memory.json" with { type: "json" }

const scratch = fileURLToPath(new URL("./tmp/", import.meta.url))
const runner = fileURLToPath(new URL("./build-assets-runner.mjs", import.meta.url))
const normalize = (value) => value.replaceAll("\\", "/")
export const VENDOR_MODULES = [
  "effect",
  "effect/unstable/httpapi",
  "solid-js",
  "solid-js/store",
  "solid-js/web",
  "@solidjs/router",
  "@tanstack/solid-query",
  "@novaclaw/sdk/v2",
  "@novaclaw/sdk/v2/client",
  "remeda",
  "luxon",
  ...[
    "accordion",
    "button",
    "checkbox",
    "collapsible",
    "context-menu",
    "dialog",
    "dropdown-menu",
    "popover",
    "segmented-control",
    "select",
    "switch",
    "tabs",
    "text-field",
    "toast",
    "tooltip",
  ].map((name) => `@kobalte/core/${name}`),
]

export function sequentialAssets() {
  let config
  const references = new Map()
  const vendors = new Map()
  return {
    name: "novaclaw:sequential-assets",
    enforce: "pre",
    apply: "build",
    configResolved(value) {
      config = value
    },
    buildStart() {
      references.clear()
      vendors.clear()
      globalThis.gc?.()
      mkdirSync(scratch, { recursive: true })
      const directory = mkdtempSync(resolve(scratch, "build-assets-"))
      try {
        for (const group of ["vendor", "worker"]) {
          const output = resolve(directory, group)
          const options = {
            group,
            output,
            root: config.root,
            target: config.build.target,
            minify: config.build.minify,
            sourcemap: config.build.sourcemap,
          }
          const result = spawnSync(
            process.execPath,
            ["--expose-gc", `--max-old-space-size=${policy.assetHeapMiB}`, runner, JSON.stringify(options)],
            {
              stdio: ["ignore", "inherit", "inherit"],
              windowsHide: true,
              timeout: 180_000,
            },
          )
          if (result.status !== 0)
            throw new Error(`The ${group} build failed (${result.status ?? result.error ?? result.signal})`)
          for (const asset of JSON.parse(readFileSync(resolve(output, "manifest.json"), "utf8"))) {
            const reference = this.emitFile({
              type: "asset",
              fileName: asset.fileName,
              source: readFileSync(resolve(output, asset.fileName)),
            })
            if (asset.module) references.set(normalize(asset.module), reference)
            if (group === "vendor" && asset.source) vendors.set(asset.source, asset.fileName)
          }
        }
      } finally {
        if (!resolve(directory).startsWith(resolve(scratch) + sep))
          throw new Error("Unexpected asset scratch directory")
        rmSync(directory, { recursive: true, force: true })
      }
    },
    async transform(code, id) {
      const imports = [...code.matchAll(/import\((['"])(@shikijs\/langs\/[^'"]+)\1\)/g)]
      if (imports.length === 0) return
      for (const match of imports.reverse()) {
        const resolved = await this.resolve(match[2], id, { skipSelf: true })
        const reference = references.get(normalize(resolved?.id ?? ""))
        if (!reference) throw new Error(`Grammar ${match[2]} has no separate build output`)
        code =
          code.slice(0, match.index) +
          `import(import.meta.ROLLUP_FILE_URL_${reference})` +
          code.slice(match.index + match[0].length)
      }
      return { code, map: null }
    },
    async resolveId(source, importer) {
      const vendor = vendors.get(source)
      if (vendor) return { id: `./${posix.basename(vendor)}`, external: true }
      if (
        source === "effect" ||
        source.startsWith("effect/") ||
        source === "solid-js" ||
        source.startsWith("solid-js/") ||
        source.startsWith("@kobalte/core/")
      )
        throw new Error(`Dependency ${source} has no separate build entry`)
      if (!source.endsWith("?worker&url")) return
      const resolved = await this.resolve(source.slice(0, -"?worker&url".length), importer, { skipSelf: true })
      const reference = references.get(normalize(resolved?.id ?? ""))
      if (!reference) throw new Error(`Worker ${source} has no separate build entry`)
      return `\0nova-worker-url:${reference}`
    },
    load(id) {
      if (id.startsWith("\0nova-worker-url:"))
        return `export default import.meta.ROLLUP_FILE_URL_${id.slice("\0nova-worker-url:".length)}`
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue
        for (const source of [...output.imports, ...output.dynamicImports]) {
          if (!source.includes("nova-vendor-")) continue
          if (!bundle[posix.join(posix.dirname(output.fileName), source)])
            throw new Error(`Dependency ${source} is unreachable from ${output.fileName}`)
        }
      }
    },
  }
}
