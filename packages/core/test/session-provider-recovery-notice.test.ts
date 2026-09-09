import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(path.join(import.meta.dir, "../src/session/runner/llm.ts"), "utf8")

test("routine provider recovery is a folded harness notice", () => {
  const recovery = source.slice(
    source.indexOf("if (providerRecovery)"),
    source.indexOf("if (providerRecovery)") + 2_500,
  )
  expect(recovery).toContain("text: applySteerProvenance(")
  expect(recovery).not.toContain("NovaClaw recovered a provider turn interrupted by process loss")
})
