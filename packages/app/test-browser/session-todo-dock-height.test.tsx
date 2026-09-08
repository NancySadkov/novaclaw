import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Todo } from "@novaclaw/sdk/v2"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { LanguageContext } from "@/context/language"
import { dict as en } from "@/i18n/en"
import { SessionTodoDock } from "@/pages/session/composer/session-todo-dock"

/**
 * **THE TODO DOCK MEASURES ITS CONTENT — IN BOTH DIRECTIONS.**
 *
 * 🔴 The dock sized itself with `setStore("height", (height) => Math.max(height, el.scrollHeight))`.
 * A value folded into the running maximum of every value before it is not a measurement: it can
 * only report growth. Tick items off, let the agent replace a twelve-item plan with a three-item
 * one, or open the dock on a long list and then switch to a session with a short one — the list
 * shrinks, the tray's `max-height` does not, and the dock keeps a band of empty background that
 * nothing on screen explains. The high-water mark never resets either, so the tallest list a tab
 * ever showed dictated the dock for the rest of that tab's life.
 *
 * ⚠️ **BOTH directions in one test, and the growth case is the control.** "The height fell" alone
 * is satisfied by a probe that is not wired to anything and reports the 78px floor throughout, and
 * a dock that never grows would pass it. So each case asserts the move it expects AND that the two
 * readings differ from each other and from the floor. Under the pre-fix code the growth case passes
 * unchanged and the shrink case fails — which is what makes the pair a discriminating test rather
 * than two restatements of the same one.
 *
 * ⚠️ **happy-dom has no layout engine**, so `scrollHeight` is 0 for every element and
 * `ResizeObserver` never fires. Both are supplied here: a `scrollHeight` derived from the element's
 * own text (so it is content-driven, exactly like the real one) and an observer whose callbacks
 * this file drives. Both are installed on globals and BOTH are handed back — this directory runs as
 * one process and a global left behind is inherited by every later file.
 *
 * ⚠️ The observer stub reproduces the one behaviour the primitive depends on:
 * `@solid-primitives/resize-observer` **de-duplicates by the entry's `contentRect`** and skips the
 * callback when the rounded width and height are unchanged. An entry with a constant rect would
 * make this file green with no measurement happening at all.
 */

type ResizeCallback = (entries: unknown[], observer: unknown) => void

const observed = new Map<ResizeCallback, Set<Element>>()

class ProbeResizeObserver {
  constructor(private readonly callback: ResizeCallback) {
    observed.set(callback, new Set())
  }
  observe(element: Element) {
    observed.get(this.callback)?.add(element)
  }
  unobserve(element: Element) {
    observed.get(this.callback)?.delete(element)
  }
  disconnect() {
    observed.get(this.callback)?.clear()
  }
}

/** The stand-in layout: four pixels of height per character the element actually contains. */
const measure = (element: Element) => (element.textContent?.length ?? 0) * 4

/** Deliver a resize to everything currently observed, carrying each element's CURRENT size. */
function flushResize() {
  for (const [callback, elements] of observed) {
    const entries = [...elements].map((target) => ({
      target,
      contentRect: { width: 320, height: measure(target) },
    }))
    if (entries.length > 0) callback(entries, undefined)
  }
}

let originalScrollHeight: PropertyDescriptor | undefined
let originalResizeObserver: unknown

beforeAll(() => {
  originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight")
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return measure(this)
    },
  })
  originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ProbeResizeObserver
})

afterAll(() => {
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight)
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight")
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver
})

const LANGUAGE = {
  t: (key: string, params?: Record<string, string | number | boolean>) => {
    const value = (en as Record<string, string>)[key]
    if (value === undefined) return key
    return params === undefined
      ? value
      : Object.entries(params).reduce((text, [name, sub]) => text.replaceAll("{{" + name + "}}", String(sub)), value)
  },
  locale: () => "en",
}

const todos = (count: number): Todo[] =>
  Array.from({ length: count }, (_, index) => ({
    content: `Rebuild the provider catalog cache, step number ${index}`,
    status: index === 0 ? "in_progress" : "pending",
    priority: "medium",
  }))

let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  observed.clear()
  document.body.innerHTML = ""
})

function mount(initial: Todo[]) {
  const [list, setList] = createSignal(initial)
  host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(
    () => (
      <LanguageContext.Provider value={LANGUAGE as never}>
        <SessionTodoDock
          todos={list()}
          collapsed={false}
          onToggle={() => undefined}
          collapseLabel="Collapse"
          expandLabel="Expand"
          dockProgress={1}
        />
      </LanguageContext.Provider>
    ),
    host,
  )
  flushResize()
  return setList
}

/** The one number the dock actually renders: the tray's `max-height`, in pixels. */
function maxHeight() {
  const dock = document.querySelector('[data-component="session-todo-dock"]')
  if (!(dock instanceof HTMLElement)) throw new Error("the dock did not render")
  return Number.parseFloat(dock.style.maxHeight)
}

/** The collapsed-bar floor `full()` clamps to. A reading pinned here measured nothing. */
const FLOOR = 78

describe("the todo dock's height follows its content", () => {
  test("it renders the todos it was given", () => {
    mount(todos(6))
    const dock = document.querySelector('[data-component="session-todo-dock"]')
    expect(dock?.textContent).toContain("step number 5")
  })

  test("CONTROL — adding todos GROWS the dock", () => {
    const setList = mount(todos(1))
    const before = maxHeight()
    expect(before).toBeGreaterThan(FLOOR)

    setList(todos(9))
    flushResize()

    const after = maxHeight()
    expect(after).toBeGreaterThan(before)
  })

  test("removing todos SHRINKS it back — the direction the high-water mark could not report", () => {
    const setList = mount(todos(9))
    const tall = maxHeight()
    expect(tall).toBeGreaterThan(FLOOR)

    setList(todos(1))
    flushResize()

    const short = maxHeight()
    expect(short).toBeLessThan(tall)
    // Not merely "different": it is the height a dock mounted on one todo has in the first place,
    // which is what "shrinks BACK" means and what a clamped-to-floor probe could not produce.
    expect(short).toBeGreaterThan(FLOOR)
  })

  test("a round trip returns to where it started", () => {
    const setList = mount(todos(2))
    const start = maxHeight()

    setList(todos(11))
    flushResize()
    const grown = maxHeight()

    setList(todos(2))
    flushResize()
    expect(grown).toBeGreaterThan(start)
    expect(maxHeight()).toBe(start)
  })

  test("an empty list still leaves the collapsed bar standing", () => {
    mount([])
    expect(maxHeight()).toBeGreaterThanOrEqual(FLOOR)
  })
})
