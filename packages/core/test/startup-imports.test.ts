import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

test("optional conversion, package installation and discovery libraries load only when used", async () => {
  for (const [file, library] of [
    ["../src/tool/webfetch.ts", "turndown"],
    ["../src/npm-config.ts", "@npmcli/config"],
    ["../../novaclaw/src/server/mdns.ts", "bonjour-service"],
    ["../../novaclaw/src/format/index.ts", "./formatter"],
  ]) {
    const source = await readFile(new URL(file!, import.meta.url), "utf8")
    expect(source).toContain(["import", "(", JSON.stringify(library), ")"].join(""))
    expect(source).not.toMatch(new RegExp(`^import(?! type).*from "${library}"`, "m"))
  }
})

test("platform services import only the implementations they use", () => {
  for (const directory of ["../../core/src", "../../novaclaw/src"]) {
    const root = path.resolve(import.meta.dir, directory)
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    )
    expect(files.length).toBeGreaterThan(100)
    for (const file of files)
      expect(readFileSync(path.join(root, file), "utf8"), file).not.toMatch(/from ["']@effect\/platform-node["']/)
  }
})

test("importing the process service never probes a Windows code page", async () => {
  const source = await readFile(new URL("../src/process.ts", import.meta.url), "utf8")
  expect(source).not.toMatch(/^(?:export )?const \w+ = windowsOutputEncoding\(\)/m)
})
