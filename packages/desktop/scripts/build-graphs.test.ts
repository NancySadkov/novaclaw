import { expect, test } from "bun:test"
import { serialMinification } from "../../app/build-minify.js"
import { bundleServer } from "../../novaclaw/script/bundle-server.mjs"
import { syntaxLanguages } from "../../app/build-syntax.js"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

test("the shared syntax catalogue retains common aliases and excludes niche grammars", async () => {
  const plugin = syntaxLanguages()
  const id = plugin.resolveId("shiki/langs", undefined)!
  const source = await plugin.load(id)
  const languages = await import("data:text/javascript;base64," + Buffer.from(source!).toString("base64"))
  expect(languages.bundledLanguagesInfo).toHaveLength(60)
  expect(languages.bundledLanguages.ts).toBe(languages.bundledLanguages.typescript)
  expect(languages.bundledLanguages.bash).toBe(languages.bundledLanguages.shellscript)
  expect(languages.bundledLanguages.python).toBeDefined()
  for (const name of ["abap", "apl", "emacs-lisp", "wolfram"]) expect(languages.bundledLanguages[name]).toBeUndefined()
})

test("chunk compilation is serial and retains results, errors, context and arguments", async () => {
  let active = 0
  let peak = 0
  const context = {}
  const plugin = {
    name: "vite:esbuild-transpile",
    async renderChunk(this: unknown, code: string, chunk: { fileName: string }) {
      expect(this).toBe(context)
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      if (code === "fail") throw new Error("Compiler failed")
      return { code, map: chunk.fileName }
    },
  }
  serialMinification().configResolved({ plugins: [plugin] })
  const results = await Promise.allSettled(
    ["first", "fail", "last"].map((code) => plugin.renderChunk.call(context, code, { fileName: code + ".js" })),
  )
  expect(peak).toBe(1)
  expect(results[0]).toEqual({ status: "fulfilled", value: { code: "first", map: "first.js" } })
  expect(results[1].status).toBe("rejected")
  expect(results[2]).toEqual({ status: "fulfilled", value: { code: "last", map: "last.js" } })
})

test("a changed Vite compiler cannot silently remove the minification boundary", () => {
  expect(() => serialMinification().configResolved({ plugins: [] })).toThrow("serial minification boundary")
})

test("the executable loads its bundled code, circular async imports and resource files", async () => {
  if (process.platform !== "win32") return
  const root = mkdtempSync(resolve(import.meta.dir, "../../../tmp/build-graphs-"))
  const output = resolve(root, "payload.mjs")
  const launcher = resolve(root, "launcher.ts")
  const executable = resolve(root, "fixture.exe")
  try {
    writeFileSync(resolve(root, "helper.ps1"), "operator text")
    writeFileSync(resolve(root, "image.webp"), new Uint8Array([1, 2, 255]))
    writeFileSync(resolve(root, "native.dll"), new Uint8Array([7, 8, 9]))
    writeFileSync(resolve(root, "config.json"), '{"enabled":true}')
    writeFileSync(resolve(root, "legacy.cjs"), 'module.exports = require("path").basename("parent/child")')
    writeFileSync(
      resolve(root, "cycle.ts"),
      'export * as Loop from "./cycle"; import { late } from "./late"; export const value = await Promise.resolve(late)',
    )
    writeFileSync(
      resolve(root, "late.ts"),
      `import * as cycle from "./cycle"; import {embeddedLibPath} from ${JSON.stringify(resolve(import.meta.dir, "../../core/node_modules/@ff-labs/fff-bun/src/embedded.ts"))}; export const late = 7; export const fff = embeddedLibPath; export const loop = () => cycle.value`,
    )
    writeFileSync(
      resolve(root, "entry.ts"),
      [
        'import text from "./helper.ps1" with {type: "text"}',
        'import image from "./image.webp" with {type: "file"}',
        'import legacy from "./legacy.cjs"',
        'import config from "./config.json" with {type: "json"}',
        `import {parse} from ${JSON.stringify(resolve(import.meta.dir, "../node_modules/jsonc-parser"))}`,
        'import {value} from "./cycle"',
        'import {fff} from "./late"',
        'const native = require("./native.dll")',
        "console.log(JSON.stringify({text, image: Array.from(await Bun.file(image).bytes()), native: Array.from(await Bun.file(native).bytes()), ffi:Array.from((await Bun.file(fff).bytes()).slice(0,2)), legacy, config, parsed:parse('{\"valid\":true}'), value}))",
      ].join("\n"),
    )
    await bundleServer({ root, output, launcher, entryPoints: ["entry.ts"] })
    const result = await Bun.build({
      entrypoints: [launcher],
      compile: { target: "bun-windows-x64", outfile: executable },
    })
    expect(result.success, JSON.stringify(result.logs)).toBe(true)
    const expected = {
      text: "operator text",
      image: [1, 2, 255],
      native: [7, 8, 9],
      ffi: [77, 90],
      legacy: "child",
      config: { enabled: true },
      parsed: { valid: true },
      value: 7,
    }
    const run = async (command: string[]) => {
      const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", windowsHide: true })
      const deadline = setTimeout(() => child.kill(), 10_000)
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        expect(exitCode, stderr).toBe(0)
        expect(JSON.parse(stdout)).toEqual(expected)
      } finally {
        clearTimeout(deadline)
        if (child.exitCode === null) child.kill()
      }
    }
    await run([executable])
    const nodeEntry = readFileSync(resolve(root, "entry.ts"), "utf8").replaceAll(
      /Bun\.file\(([^)]+)\)\.bytes\(\)/g,
      "readFile($1)",
    )
    writeFileSync(resolve(root, "entry.ts"), 'import {readFile} from "node:fs/promises";\n' + nodeEntry)
    const nodeOutput = resolve(root, "node")
    await bundleServer({ root, output: nodeOutput, runtime: "node", entryPoints: ["entry.ts"] })
    await run(["node", resolve(nodeOutput, "entry.js")])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
