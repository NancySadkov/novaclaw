import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./session-context-tab.tsx", import.meta.url), "utf8")

test("the context manager exposes manual compaction", () => {
  expect(source).toContain('"context.compactions.compactNow"')
  expect(source).toContain("client.v2.session.compact({ sessionID })")
})
