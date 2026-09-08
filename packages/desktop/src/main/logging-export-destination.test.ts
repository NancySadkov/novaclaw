import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./logging.ts", import.meta.url), "utf8")

test("debug archives stay in NovaClaw logs or the allowed OS temp fallback", () => {
  expect(source).toContain("root || tmpdir()")
  expect(source).not.toContain('app.getPath("downloads")')
})
