import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { ScrollView } from "@novaclaw/ui/scroll-view"
import { TextStrikethrough } from "@novaclaw/ui/text-strikethrough"

/**
 * **A COMPONENT THAT MEASURES ONCE IS CORRECT UNTIL ITS CONTENT CHANGES.**
 *
 * 🔴 Two components in `packages/ui` derived a number from the DOM at mount and wired that
 * derivation to a set of triggers that did not include the thing which actually changes it.
 *
 * · `ScrollView` observed `viewportRef.firstElementChild` — read once, inside `onMount`, and handed
 *   to a primitive as a plain array, which is not an accessor and therefore tracks nothing. A
 *   consumer whose child is replaced after mount (the file viewer's `<Switch>`, still in its loading
 *   arm when the view mounts) left the observer bound to a detached node. The viewport's own size
 *   does not change when its content grows, so `showThumb` stayed false: no scrollbar thumb at all
 *   until the user produced a scroll event, the only other caller of `updateThumb`.
 *
 * · `TextStrikethrough` measured on mount and on a container resize. Its container is a grid cell
 *   sized by the dock, so rewriting the row's text does not resize it; `textWidth` kept the previous
 *   string's width and the strike line stopped short of the new text or ran past it.
 *
 * ⚠️ **Each case asserts the SAME reading before the change and after it**, and the before-reading
 * has to pass in the unfixed tree or the test is measuring its own fixture rather than the fix.
 * The `ScrollView` case adds a second control: after the swap, a plain `scroll` event still produces
 * the thumb in EITHER tree, which is what proves the stand-in geometry below is right and that a
 * failure means "nothing re-measured", not "nothing could have".
 *
 * ⚠️ **happy-dom has no layout engine.** `scrollHeight`/`clientHeight`/`scrollWidth`/`offsetWidth`
 * are 0 for every element and its `ResizeObserver` is a documented no-op — so the geometry is
 * supplied here, derived from what each element actually contains, and every global taken is handed
 * back in `afterAll`. This directory runs as ONE process and a global left behind is inherited by
 * every later file.
 *
 * 🔴 **`MutationObserver` is driven here rather than awaited, and the reason is measured.**
 * happy-dom keeps each listener's callback in a `WeakRef`
 * (`happy-dom/lib/mutation-observer/MutationObserverListener.js`) and nothing else holds a strong
 * reference to it, so once the garbage collector runs the observer silently stops reporting. That is
 * not a hypothesis: this file's first assertion passed when its two files ran alone and failed in
 * the same commit when the whole directory ran, which is the shape of a test whose result is a
 * function of when GC happened. Real browsers deliver these on a microtask and the product is
 * unaffected; a test that waits on them is measuring the collector.
 */

/** Stand-in layout: an element declares its own height, and a text run is ten pixels per character. */
const declaredHeight = (element: Element): number => {
  const own = element.getAttribute?.("data-probe-height")
  if (own !== null && own !== undefined) return Number(own)
  const child = element.firstElementChild?.getAttribute("data-probe-height")
  return child === null || child === undefined ? 0 : Number(child)
}

const VIEWPORT_HEIGHT = 100
const CONTAINER_WIDTH = 200

type MutationCallback = (records: unknown[], observer: unknown) => void

/** Everything each observer is watching, so the test can deliver a record instead of hoping for one. */
const watched = new Map<MutationCallback, Set<Node>>()

class ProbeMutationObserver {
  constructor(private readonly callback: MutationCallback) {
    watched.set(callback, new Set())
  }
  observe(target: Node) {
    watched.get(this.callback)?.add(target)
  }
  disconnect() {
    watched.delete(this.callback)
  }
  takeRecords() {
    return []
  }
}

/** Tell every live observer that its target's children changed. */
function flushMutations() {
  for (const [callback, targets] of watched) {
    const records = [...targets].map((target) => ({ type: "childList", target }))
    if (records.length > 0) callback(records, undefined)
  }
}

const taken: { name: string; owner: object; descriptor: PropertyDescriptor | undefined }[] = []
let originalMutationObserver: unknown

function stub(owner: object, name: string, get: (this: Element) => number) {
  taken.push({ name, owner, descriptor: Object.getOwnPropertyDescriptor(owner, name) })
  Object.defineProperty(owner, name, { configurable: true, get })
}

beforeAll(() => {
  stub(Element.prototype, "scrollHeight", function (this: Element) {
    return declaredHeight(this)
  })
  stub(HTMLElement.prototype, "clientHeight", function (this: Element) {
    return this.classList.contains("scroll-view__viewport") ? VIEWPORT_HEIGHT : declaredHeight(this)
  })
  stub(Element.prototype, "scrollWidth", function (this: Element) {
    return (this.textContent?.length ?? 0) * 10
  })
  stub(HTMLElement.prototype, "offsetWidth", function () {
    return CONTAINER_WIDTH
  })
  originalMutationObserver = (globalThis as { MutationObserver?: unknown }).MutationObserver
  ;(globalThis as { MutationObserver?: unknown }).MutationObserver = ProbeMutationObserver
})

afterAll(() => {
  for (const { owner, name, descriptor } of taken.reverse()) {
    if (descriptor) Object.defineProperty(owner, name, descriptor)
    else Reflect.deleteProperty(owner, name)
  }
  taken.length = 0
  ;(globalThis as { MutationObserver?: unknown }).MutationObserver = originalMutationObserver
})

let dispose: (() => void) | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  host?.remove()
  host = undefined
  watched.clear()
  document.body.innerHTML = ""
})

function mount(component: () => unknown) {
  host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(component as never, host)
}

/** Let Solid flush its effects, then hand every observer the record a browser would have delivered. */
const settle = async () => {
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  flushMutations()
  await new Promise<void>((resolve) => queueMicrotask(resolve))
}

const thumb = () => document.querySelector(".scroll-view__thumb")

describe("ScrollView follows the child it is actually showing", () => {
  test("🔴 the thumb appears when a swapped-in child is taller than the viewport", async () => {
    const [loaded, setLoaded] = createSignal(false)
    mount(() => (
      <ScrollView>
        <Show when={loaded()} fallback={<div data-probe-height="40">loading</div>}>
          <div data-probe-height="900">the file</div>
        </Show>
      </ScrollView>
    ))
    await settle()

    // Before: the mounted child is shorter than the viewport, so there is correctly no thumb.
    // This reading is identical in both trees — it is the control, not the finding.
    expect(document.querySelector(".scroll-view__viewport")?.textContent).toBe("loading")
    expect(thumb(), "a thumb for content that fits means the stand-in geometry is wrong").toBeNull()

    setLoaded(true)
    await settle()

    expect(document.querySelector(".scroll-view__viewport")?.textContent).toBe("the file")
    expect(thumb(), "the child was replaced and the thumb never re-measured").not.toBeNull()
  })

  test("a scroll event still produces the thumb — so a failure above is the missing trigger", async () => {
    const [loaded, setLoaded] = createSignal(false)
    mount(() => (
      <ScrollView>
        <Show when={loaded()} fallback={<div data-probe-height="40">loading</div>}>
          <div data-probe-height="900">the file</div>
        </Show>
      </ScrollView>
    ))
    await settle()
    setLoaded(true)
    await settle()

    const viewport = document.querySelector(".scroll-view__viewport")
    viewport?.dispatchEvent(new Event("scroll"))
    await settle()
    expect(thumb()).not.toBeNull()
  })

  test("content that fits never grows a thumb, however often it is replaced", async () => {
    const [loaded, setLoaded] = createSignal(false)
    mount(() => (
      <ScrollView>
        <Show when={loaded()} fallback={<div data-probe-height="40">loading</div>}>
          <div data-probe-height="60">the file</div>
        </Show>
      </ScrollView>
    ))
    await settle()
    setLoaded(true)
    await settle()
    expect(thumb()).toBeNull()
  })
})

/** The base span's `clip-path` is `inset(0 0 0 ${progress * textWidth}px)` — the measurement itself. */
function measuredTextWidth() {
  const root = document.querySelector('[data-component="text-strikethrough"]')
  const base = root?.firstElementChild
  if (!(base instanceof HTMLElement)) throw new Error("the strikethrough did not render")
  const clip = base.style.getPropertyValue("clip-path") || base.style.clipPath || base.getAttribute("style") || ""
  const match = /inset\(0 0 0 ([\d.]+)px\)/.exec(clip)
  if (!match) throw new Error(`clip-path carried no measurement: ${clip}`)
  return Number(match[1])
}

describe("TextStrikethrough re-measures when its text changes", () => {
  test("🔴 the strike length follows a rewritten string", async () => {
    const [text, setText] = createSignal("abc")
    // `active` is true from the first render, so the spring's initial value already equals its
    // target and `progress()` is 1 — the clip is then exactly the measured text width, with no
    // animation to wait on.
    mount(() => <TextStrikethrough active text={text()} />)
    await settle()

    // Before: three characters at ten pixels each. Identical in both trees.
    expect(measuredTextWidth()).toBe(30)

    setText("abcdefghij")
    await settle()

    expect(measuredTextWidth(), "the text was rewritten and the width kept the old string's").toBe(100)
  })

  test("a shorter string moves the measurement back down", async () => {
    const [text, setText] = createSignal("abcdefghij")
    mount(() => <TextStrikethrough active text={text()} />)
    await settle()
    expect(measuredTextWidth()).toBe(100)

    setText("ab")
    await settle()
    expect(measuredTextWidth()).toBe(20)
  })
})
