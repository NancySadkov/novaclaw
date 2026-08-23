import { plugin } from "bun"
import { readFileSync } from "node:fs"
import { transformSync } from "@babel/core"
// @ts-expect-error — no types ship with the preset
import solid from "babel-preset-solid"
// @ts-expect-error — no types ship with the preset
import typescript from "@babel/preset-typescript"

/**
 * Compile `.tsx` with the REAL Solid transform, so a rendering test exercises the code that ships.
 *
 * 🔴 **Why this file exists, and why the app had no rendering test until it did.** `bun test`
 * transpiles JSX with its own React transform — measured inside this very package, whose
 * `tsconfig.json` already sets `jsx: "preserve"` and `jsxImportSource: "solid-js"`:
 *
 *     bun build ./probe.tsx  →  React.createElement("div", { class: "a" }, x)
 *
 * `preserve` is not honoured, so importing any `.tsx` from a test dies on `ReferenceError: React is
 * not defined`. That is the mechanism behind the 2026-08-23 named-agents review finding eleven
 * defects in two `.tsx` files: the only instruments that could reach them `readFileSync` the source
 * and match regexes — the *test that checks itself*, at file scope.
 *
 * ⚠️ **`babel-preset-solid`, not `solid-js/h/jsx-runtime`.** Solid ships a runtime JSX factory that
 * would have silenced the import error in one line, and it would have been the wrong fix: `h` has
 * different reactivity semantics from the compiled output, so the test would pass or fail on a code
 * path the product never runs. *A control validates a PATH, not an experiment* — the transform under
 * test has to be the transform that ships, which is this preset (what `vite-plugin-solid` applies).
 *
 * ⚠️ **All three presets are DECLARED devDependencies**, deliberately. An earlier draft resolved
 * `@babel/core` and `babel-preset-solid` out of bun's store by glob, since both are transitive deps
 * of `vite-plugin-solid`. `renderer-dependency-ledger.test.ts` rejected that and was right to: an
 * undeclared dependency breaks anyone who installs only what the manifest names, and the glob was
 * itself evidence of the fragility. Declaring them deleted the hack.
 *
 * `generate: "dom"` and `hydratable: false` match the app's own Vite config.
 *
 * ⚠️ Registered in TWO places, both load-bearing: `package.json`'s `test:browser` script and
 * `script/lib/run-units.ts`'s `app:browser` args. The GATE runs the latter, so wiring only the
 * script leaves `bun run test --only=app` red while a direct `bun run test:browser` is green.
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
