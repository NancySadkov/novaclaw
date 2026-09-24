import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./logging.ts", import.meta.url), "utf8")

test("debug archives stay in NovaClaw's instance profile", () => {
  expect(source).toContain('root || join(app.getPath("userData"), "tmp")')
  expect(source).not.toContain("tmpdir()")
  expect(source).not.toContain('app.getPath("downloads")')
})
