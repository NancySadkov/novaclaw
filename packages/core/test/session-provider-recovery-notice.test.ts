import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const source = fs.readFileSync(path.join(import.meta.dir, "../src/session/runner/llm.ts"), "utf8")

test("routine provider recovery is a folded harness notice, while the loop failure remains visible", () => {
  const recovery = source.slice(
    source.indexOf("if (providerRecovery)"),
    source.indexOf("if (providerRecovery)") + 2_500,
  )
  expect(recovery).toContain("text: applySteerProvenance(")
  expect(recovery).not.toContain("NovaClaw recovered a provider turn interrupted by process loss")

  // The circuit-open path deliberately does not receive steer provenance: this is the exceptional
  // case the user asked to remain visible rather than another folded routine recovery marker.
  const worker = fs.readFileSync(path.join(import.meta.dir, "../../novaclaw/src/session-worker/execution.ts"), "utf8")
  expect(worker).toContain("text: pausedNotice(")
  expect(worker).not.toMatch(/text:\s*applySteerProvenance\(\s*pausedNotice/)
})
