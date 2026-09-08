import { describe, expect, test } from "bun:test"
import { REDUCED_MOTION_QUERY, watchMedia, type MediaQueryLike } from "./reduced-motion"

/** A media query somebody can change, which is the only interesting kind. */
function fakeQuery(initial: boolean) {
  const listeners: ((event: { matches: boolean }) => void)[] = []
  const query = {
    matches: initial,
    addEventListener: (_type: "change", listener: (event: { matches: boolean }) => void) => {
      listeners.push(listener)
    },
    removeEventListener: (_type: "change", listener: (event: { matches: boolean }) => void) => {
      const at = listeners.indexOf(listener)
      if (at >= 0) listeners.splice(at, 1)
    },
  } as MediaQueryLike & { matches: boolean }
  return {
    query,
    change: (matches: boolean) => {
      ;(query as { matches: boolean }).matches = matches
      for (const listener of [...listeners]) listener({ matches })
    },
    get listenerCount() {
      return listeners.length
    },
  }
}

describe("watchMedia", () => {
  test("the current value arrives immediately", () => {
    const seen: boolean[] = []
    watchMedia(fakeQuery(true).query, (value) => seen.push(value))
    expect(seen).toEqual([true])
  })

  test("🔴 a LATER change is delivered — the whole reason this is a listener and not a read", () => {
    // A one-time read at mount keeps flaring at somebody who has just asked it to stop, and that
    // is exactly when a person changes this setting: in response to something moving.
    const fake = fakeQuery(false)
    const seen: boolean[] = []
    watchMedia(fake.query, (value) => seen.push(value))
    fake.change(true)
    fake.change(false)
    expect(seen).toEqual([false, true, false])
  })

  test("unsubscribing stops delivery and leaves no listener behind", () => {
    const fake = fakeQuery(false)
    const seen: boolean[] = []
    const stop = watchMedia(fake.query, (value) => seen.push(value))
    stop()
    expect(fake.listenerCount).toBe(0)
    fake.change(true)
    expect(seen).toEqual([false])
  })

  test("⚠️ no matchMedia at all still answers once, rather than never", () => {
    const seen: boolean[] = []
    const stop = watchMedia(undefined, (value) => seen.push(value))
    expect(seen).toEqual([false])
    expect(() => stop()).not.toThrow()
  })

  test("a legacy addListener query is subscribed too", () => {
    const listeners: ((event: { matches: boolean }) => void)[] = []
    const query: MediaQueryLike = {
      matches: true,
      addListener: (listener) => listeners.push(listener),
      removeListener: (listener) => listeners.splice(listeners.indexOf(listener), 1),
    }
    const seen: boolean[] = []
    const stop = watchMedia(query, (value) => seen.push(value))
    listeners[0]!({ matches: false })
    expect(seen).toEqual([true, false])
    stop()
    expect(listeners).toHaveLength(0)
  })

  test("the query string is the standard one, spelled once", () => {
    expect(REDUCED_MOTION_QUERY).toBe("(prefers-reduced-motion: reduce)")
  })
})
