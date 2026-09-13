import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("./tooltip-v2.tsx", import.meta.url), "utf8")

test("tooltips never cancel the first pointer press on their trigger", () => {
  expect(source).toContain('onPointerDownCapture={arm}')
  expect(source).not.toContain("onPointerDownOutside")
  expect(source).not.toContain("justClickedTrigger")
})
