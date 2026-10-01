import { mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "vite"
import { serialMinification } from "./build-minify.js"
import { VENDOR_MODULES } from "./build-assets.js"
import { syntaxLanguageInfo, syntaxLanguages } from "./build-syntax.js"

const options = JSON.parse(process.argv[2])
const require = createRequire(import.meta.url)
let input
const vendorSources = new Map()
if (options.group === "vendor") {
  const directory = resolve(options.output, "..", "vendor-inputs")
  mkdirSync(directory, { recursive: true })
  input = Object.fromEntries(
    VENDOR_MODULES.map((source) => {
      const name = source.replaceAll("/", "-").replaceAll("@", "")
      const file = resolve(directory, name + ".mjs")
      writeFileSync(file, `export * from ${JSON.stringify(source)}`)
      vendorSources.set(name, source)
      return [name, file]
    }),
  )
} else if (options.group === "worker") {
  const catalogue = require.resolve("shiki/langs")
  const languages = createRequire(catalogue)
  const bundledLanguagesInfo = await syntaxLanguageInfo()
  input = {
    markdown: fileURLToPath(new URL("../session-ui/src/components/markdown-shiki.worker.ts", import.meta.url)),
    diffs: fileURLToPath(import.meta.resolve("@pierre/diffs/worker/worker.js")),
    ...Object.fromEntries(
      bundledLanguagesInfo.map(({ id }) => [`lang-${id}`, languages.resolve(`@shikijs/langs/${id}`)]),
    ),
  }
} else throw new Error(`Unknown asset group ${options.group}`)

const result = await build({
  configFile: false,
  publicDir: false,
  plugins: [syntaxLanguages(), serialMinification()],
  root: options.root,
  build: {
    outDir: options.output,
    emptyOutDir: true,
    target: options.target,
    minify: options.minify,
    sourcemap: options.sourcemap,
    reportCompressedSize: false,
    rollupOptions: {
      preserveEntrySignatures: "strict",
      input,
      output: {
        format: "es",
        entryFileNames: `assets/nova-${options.group}-[name]-[hash].js`,
        chunkFileNames: `assets/nova-${options.group}-[name]-[hash].js`,
        assetFileNames: `assets/nova-${options.group}-[name]-[hash][extname]`,
      },
    },
  },
})
const manifest = (Array.isArray(result) ? result : [result])
  .flatMap((item) => item.output)
  .map((asset) => ({
    fileName: asset.fileName,
    module: asset.type === "chunk" ? asset.facadeModuleId : undefined,
    entry: asset.type === "chunk" && asset.isEntry,
    name: asset.type === "chunk" ? asset.name : undefined,
    source: asset.type === "chunk" && asset.isEntry ? vendorSources.get(asset.name) : undefined,
  }))
writeFileSync(resolve(options.output, "manifest.json"), JSON.stringify(manifest))
