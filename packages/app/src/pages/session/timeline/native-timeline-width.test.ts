import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Ruling 1 — the chat may never draw a horizontal scrollbar.
 *
 * `overflow-y-auto` alone computes `overflow-x: auto` on the other axis (a non-`visible` overflow
 * forces its pair out of `visible`), so the chat scroller silently became horizontally scrollable.
 * One unbreakable line in a message — an OS path in a permission-denied notice was the observed case
 * — then drew a bar across the whole conversation. NovaClaw runs on phones, so this is a product
 * invariant, not a style preference: content narrows to the viewport instead. Source assertion
 * because a dropped utility class is exactly the kind of regression that compiles green.
 */
const timeline = readFileSync(join(import.meta.dir, "native-timeline.tsx"), "utf8")
const globalCss = readFileSync(join(import.meta.dir, "..", "..", "..", "index.css"), "utf8")

describe("the chat view has one axis", () => {
  test("the chat scroller clips the horizontal axis it never wants", () => {
    const scroller = timeline.slice(
      timeline.indexOf('data-component="native-timeline"') - 120,
      timeline.indexOf('data-component="native-timeline"'),
    )
    expect(scroller).toContain("overflow-y-auto")
    expect(scroller).toContain("overflow-x-hidden")
  })

  test("no surface in the shell may paint a horizontal scrollbar", () => {
    expect(globalCss).toContain("::-webkit-scrollbar:horizontal")
  })
})
