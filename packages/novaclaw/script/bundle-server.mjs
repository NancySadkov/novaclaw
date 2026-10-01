import { build, stop } from "esbuild"
import { createHash } from "node:crypto"
import { basename, dirname, resolve } from "node:path"
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

export async function bundleServer(options) {
  const nodeRuntime = options.runtime === "node"
  const resources = new Map()
  const resourceDirectory = nodeRuntime ? options.output : resolve(dirname(options.output), "assets")
  const resourcePrefix = nodeRuntime ? "./" : "./assets/"
  mkdirSync(resourceDirectory, { recursive: true })
  const resourceKey = (file) => {
    const key = createHash("sha256").update(file).digest("hex") + "-" + basename(file)
    resources.set(key, file)
    return key
  }
  try {
    await build({
      absWorkingDir: options.root,
      entryPoints: options.entryPoints ?? ["./src/index.ts"],
      ...(nodeRuntime ? { outdir: options.output, splitting: true } : { outfile: options.output }),
      bundle: true,
      platform: "node",
      mainFields: ["module", "main"],
      conditions: nodeRuntime ? ["node"] : ["bun", "node"],
      target: nodeRuntime ? "node24" : "esnext",
      format: "esm",
      minify: true,
      keepNames: true,
      banner: {
        js:
          (nodeRuntime ? "" : "// @bun\n") +
          'import { createRequire as novaCreateRequire } from "node:module"; const require = novaCreateRequire(import.meta.url); const __novaResourceModuleURL = import.meta.url;',
      },
      sourcemap: options.sourcemaps ? (nodeRuntime ? "linked" : "inline") : false,
      external: nodeRuntime ? ["jsonc-parser", "@lydell/node-pty", "@mtcute/bun"] : ["node-gyp", "bun", "bun:*"],
      loader: { ".txt": "text" },
      define: options.define,
      plugins: [
        {
          name: "novaclaw:resource-files",
          setup(api) {
            api.onLoad({ filter: /[\\/]fff-bun[\\/]src[\\/]embedded\.ts$/ }, (args) => {
              const platform = JSON.parse(options.define?.["process.platform"] ?? JSON.stringify(process.platform))
              const arch = JSON.parse(options.define?.["process.arch"] ?? JSON.stringify(process.arch))
              const libc = JSON.parse(options.define?.FFF_LIBC ?? '"gnu"')
              const suffix = platform === "linux" ? `linux-${arch}-${libc}` : `${platform}-${arch}`
              const file = platform === "win32" ? "fff_c.dll" : platform === "darwin" ? "libfff_c.dylib" : "libfff_c.so"
              return {
                contents: `import file from ${JSON.stringify(`@ff-labs/fff-bin-${suffix}/${file}`)} with {type:"file"}; export const embeddedLibPath = file;`,
                loader: "ts",
                resolveDir: dirname(args.path),
              }
            })
            api.onResolve({ filter: /novaclaw-web-ui\.gen\.ts$/ }, () => ({ path: "web-ui", namespace: "embedded-ui" }))
            api.onLoad({ filter: /.*/, namespace: "embedded-ui" }, () => ({
              contents: options.embeddedFileMap ?? "export default {}",
              loader: "ts",
              resolveDir: options.root,
            }))
            api.onResolve({ filter: /.*/ }, async (args) => {
              const binary = /\.(wasm|dll|dylib|so|node)$/.test(args.path)
              if ((args.with.type !== "file" && args.with.type !== "text" && !binary) || args.pluginData === "resource")
                return
              const result = await api.resolve(args.path, {
                resolveDir: args.resolveDir,
                kind: args.kind,
                pluginData: "resource",
              })
              if (result.errors.length) return { errors: result.errors }
              return {
                path: result.path,
                namespace: args.with.type === "text" ? "text-resource" : "binary-resource",
                pluginData: args.kind === "require-call",
              }
            })
            api.onLoad({ filter: /.*/, namespace: "text-resource" }, (args) => ({
              contents: readFileSync(args.path, "utf8"),
              loader: "text",
            }))
            api.onLoad({ filter: /.*/, namespace: "binary-resource" }, (args) => ({
              contents: args.pluginData
                ? `module.exports = require("node:url").fileURLToPath(new URL(${JSON.stringify(resourcePrefix + resourceKey(args.path))}, __novaResourceModuleURL))`
                : `import {fileURLToPath} from "node:url"; export default fileURLToPath(new URL(${JSON.stringify(resourcePrefix + resourceKey(args.path))}, import.meta.url))`,
              loader: "js",
            }))
          },
        },
      ],
    })
    const entries = [...resources].sort(([left], [right]) => left.localeCompare(right))
    for (const [key, file] of entries) copyFileSync(file, resolve(resourceDirectory, key))
    if (options.launcher)
      writeFileSync(
        options.launcher,
        [
          'import {dirname, join} from "node:path";',
          'import {pathToFileURL} from "node:url";',
          `await import(pathToFileURL(join(dirname(process.execPath), ${JSON.stringify(basename(options.output))})).href);`,
        ].join("\n"),
      )
  } finally {
    stop()
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const plan = JSON.parse(readFileSync(process.argv[2], "utf8"))
  for (const options of plan) await bundleServer(options)
}
