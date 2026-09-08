import { afterEach, describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { AppPageHeader } from "@/components/app-page"

/**
 * **`AppPageHeader`, RENDERED against the markup it replaced** (RF-19-14).
 *
 * 🔴 Seven pages each wrote out the same title row. Six were byte-identical; `debug.tsx` and
 * `registry.tsx` had drifted to `gap-2`, `py-3`, a `size-5` glyph, a 14px title and a
 * non-flexing hint. A component merge like this is exactly the change a type checker approves and a
 * user notices, so the expectations below are the PRE-MERGE strings, copied out of the eight pages
 * before they were edited, not read back off the component.
 *
 * ⚠️ The two cases that are not about the class string are the ones that actually break layout:
 *
 * - **An absent hint must render NOTHING.** `files.tsx` has no hint and its buttons sit immediately
 *   after the title. A `flex-1` spacer standing in for the missing hint would have shoved every one
 *   of them to the right edge — a visual regression a snapshot of the *other* six would have missed.
 * - **A present hint IS the spacer.** `min-w-0 flex-1 truncate` is what pushes trailing controls to
 *   the right AND keeps a long sentence from pushing them off a narrow window.
 */

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

function mount(node: () => Element) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(node as never, host)
  return host.querySelector("[data-component='app-page-header']") as HTMLElement
}

/** The row class the six identical pages carried, verbatim. */
const ROOT = "flex items-center gap-3 border-b border-v2-border-border-base px-4 py-2.5"
/** The class `debug.tsx` and `registry.tsx` had drifted to. */
const ROOT_DENSE = "flex items-center gap-2 border-b border-v2-border-border-base px-4 py-3"

const classesOf = (element: Element | null) => [...(element?.classList ?? [])].toSorted().join(" ")
const expected = (value: string) => value.split(" ").toSorted().join(" ")

describe("the standard header emits what the six identical copies emitted", () => {
  test("root, glyph size, title size and the truncating hint", () => {
    const header = mount(() => (
      <AppPageHeader glyph="trash" title="Trash" hint="Deleted things live here for a while." />
    ))
    expect(classesOf(header)).toBe(expected(ROOT))

    const spans = header.querySelectorAll("span")
    // The glyph renders inside its own element; the two SPANS are title then hint.
    const title = [...spans].find((span) => span.textContent === "Trash")
    expect(classesOf(title!)).toBe(expected("text-[15px] font-semibold"))

    const hint = [...spans].find((span) => span.textContent?.startsWith("Deleted"))
    expect(classesOf(hint!)).toBe(expected("min-w-0 flex-1 truncate text-xs text-v2-text-text-faint"))
  })

  test("trailing controls come after the hint, so the hint's flex-1 pushes them right", () => {
    const header = mount(() => (
      <AppPageHeader glyph="trash" title="Trash" hint="a hint">
        <button type="button">Refresh</button>
      </AppPageHeader>
    ))
    const children = [...header.children]
    const hintIndex = children.findIndex((child) => child.textContent === "a hint")
    const buttonIndex = children.findIndex((child) => child.tagName === "BUTTON")
    expect(hintIndex).toBeGreaterThan(-1)
    expect(buttonIndex).toBeGreaterThan(hintIndex)
  })

  test("🔴 NO hint renders NO element — files.tsx's buttons must stay next to the title", () => {
    const header = mount(() => (
      <AppPageHeader glyph="files" title="Files">
        <button type="button">Up</button>
      </AppPageHeader>
    ))
    // One title span, and nothing between it and the button. A spacer here is the regression.
    const children = [...header.children]
    const buttonIndex = children.findIndex((child) => child.tagName === "BUTTON")
    const titleIndex = children.findIndex((child) => child.textContent === "Files")
    expect(buttonIndex).toBe(titleIndex + 1)
    expect(header.querySelector(".flex-1")).toBeNull()
  })

  test("no glyph renders no glyph", () => {
    const header = mount(() => <AppPageHeader title="Bare" />)
    expect(header.textContent).toBe("Bare")
  })
})

describe("dense reproduces the debug/registry variant exactly rather than normalising it", () => {
  test("root, 14px title and the non-flexing 12px hint", () => {
    const header = mount(() => <AppPageHeader dense glyph="debug" title="Debug" hint="diagnostics and recovery" />)
    expect(classesOf(header)).toBe(expected(ROOT_DENSE))

    const spans = [...header.querySelectorAll("span")]
    const title = spans.find((span) => span.textContent === "Debug")
    expect(classesOf(title!)).toBe(expected("text-[14px] font-semibold text-v2-text-text-base"))

    const hint = spans.find((span) => span.textContent === "diagnostics and recovery")
    expect(classesOf(hint!)).toBe(expected("text-[12px] text-v2-text-text-faint"))
    // ⚠️ NOT flex-1/truncate. Those two pages never had it, and a header merge is not the place to
    // change what a screen looks like.
    expect(hint!.classList.contains("flex-1")).toBe(false)
    expect(hint!.classList.contains("truncate")).toBe(false)
  })

  test("the two variants really are different — otherwise every assertion above is one assertion", () => {
    expect(ROOT).not.toBe(ROOT_DENSE)
    const plain = mount(() => <AppPageHeader title="x" hint="y" />)
    const plainClasses = classesOf(plain)
    dispose?.()
    document.body.innerHTML = ""
    const dense = mount(() => <AppPageHeader dense title="x" hint="y" />)
    expect(classesOf(dense)).not.toBe(plainClasses)
  })
})
