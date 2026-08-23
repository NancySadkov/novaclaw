import { plugin, Glob } from "bun"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * `@babel/core` and `babel-preset-solid` are TRANSITIVE deps (of `vite-plugin-solid`), so they live
 * in bun's content-addressed store and are not resolvable from this package. Rather than add two
 * devDependencies — a lockfile change, which this repo treats as a deliberate reviewable act
 * (`bunfig.toml`, `frozenLockfile`) — they are located in the store at load time.
 *
 * ⚠️ Found by GLOB, never by a hard-coded path: the store directory carries both the version and a
 * content hash (`@babel+core@7.28.4+4c394a5b…`), so a pinned string would rot silently on the next
 * lockfile change and this file would fail with a confusing module error instead of a clear one.
 */
const storeRoot = path.resolve(import.meta.dir, "../../node_modules/.bun")
function fromStore(pkg: string): string {
  const dir = [...new Glob(`${pkg.replace("/", "+")}@*`).scanSync({ cwd: storeRoot, onlyFiles: false })].sort().pop()
  if (!dir)
    throw new Error(
      `solid-preload: cannot find ${pkg} in ${storeRoot}. ` +
        `It is a transitive dep of vite-plugin-solid; if the tree changed, add it as a devDependency of packages/app.`,
    )
  return path.join(storeRoot, dir, "node_modules", pkg)
}

const { transformSync } = (await import(fromStore("@babel/core"))) as typeof import("@babel/core")
const solid = ((await import(fromStore("babel-preset-solid"))) as { default: unknown }).default
const typescript = ((await import(fromStore("@babel/preset-typescript"))) as { default: unknown }).default

/**
 * Compile `.tsx` with the REAL Solid transform, so a rendering test exercises the code that ships.
 *
 * 🔴 Why this file exists. `bun test` transpiles JSX with its own (React) transform, so importing any
 * `.tsx` from a test dies on `ReferenceError: React is not defined`. That is the whole reason this
 * repo had never rendered a component in a test — and it is why the 2026-08-23 named-agents review
 * found eleven defects that no instrument could see, in exactly the two `.tsx` files the ledgers
 * could only `readFileSync` and grep.
 *
 * ⚠️ **`babel-preset-solid`, not `solid-js/h/jsx-runtime`.** Solid ships a runtime JSX factory that
 * would have made the import error go away in one line, and it would have been the wrong fix: `h`
 * has different reactivity semantics from the compiled output, so the test would pass or fail on a
 * code path the product never runs. `a control validates a PATH, not an experiment` — the transform
 * under test has to be the transform that ships, which is this preset (the one `vite-plugin-solid`
 * itself applies).
 *
 * `generate: "dom"` and `hydratable: false` match the app's own Vite config.
 */
plugin({
  name: "solid-tsx",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, (args) => {
      const source = readFileSync(args.path, "utf8")
      const result = transformSync(source, {
        filename: args.path,
        babelrc: false,
        configFile: false,
        sourceMaps: "inline",
        presets: [
          [typescript, {}],
          [solid, { generate: "dom", hydratable: false }],
        ],
      })
      return { contents: result?.code ?? source, loader: "js" }
    })
  },
})
