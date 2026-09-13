import { expect, test } from "bun:test"

const source = await Bun.file(new URL("./memory.ts", import.meta.url)).text()

test("authoritative memory reads cannot collapse store failures into empty results", () => {
  expect(source).not.toContain("Effect.orElseSucceed(() => [])")
  expect(source.match(/asBadRequest\(memory\.byIds/g)?.length).toBeGreaterThanOrEqual(3)
  expect(source).toContain(".pipe(asBadRequest)")
})
