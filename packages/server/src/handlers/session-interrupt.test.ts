import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./session.ts", import.meta.url), "utf8")

test("a reasoned worker interruption is durably reported to its direct superior", () => {
  const handler = source.slice(source.indexOf('"session.interrupt"'), source.indexOf('"session.bash.list"'))
  expect(handler).toContain("const target = yield* session.get(ctx.params.sessionID)")
  expect(handler).toContain("if (target.parentID)")
  expect(handler).toContain("sessionID: target.parentID")
  expect(handler).toContain("The user stopped your worker ${target.id}. Reason: ${reason}")
})
