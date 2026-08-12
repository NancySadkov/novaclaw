import { describe, expect, test } from "bun:test"
import {
  describeDisposeFailures,
  disposeInstance,
  registerDisposer,
} from "../src/effect/instance-registry"

/**
 * 🔴 The defect: `disposeInstance` ran an `allSettled` and DISCARDED its results, over a `Set` of
 * anonymous functions. A disposer that rejected did so in total silence — and even if the results
 * had been kept, there was no name to report. At shutdown that is how unflushed state gets lost
 * with nothing on record saying which subsystem lost it.
 */
describe("instance disposer registry", () => {
  test("a rejecting disposer is reported BY NAME instead of vanishing", async () => {
    const off = registerDisposer("terminals", async () => {
      throw new Error("pty still attached")
    })
    try {
      const failures = await disposeInstance("/tmp/x")
      expect(failures).toHaveLength(1)
      expect(failures[0]!.name).toBe("terminals")
      expect(describeDisposeFailures(failures)).toEqual(["terminals (pty still attached)"])
    } finally {
      off()
    }
  })

  test("one refusing subsystem does not stop the others from being released", async () => {
    const released: string[] = []
    const offBad = registerDisposer("model workers", async () => {
      throw new Error("nope")
    })
    const offGood = registerDisposer("location services", async () => {
      released.push("location services")
    })
    try {
      const failures = await disposeInstance("/tmp/x")
      // The survivor matters more than the failure: the subsystems queued behind a stuck one are
      // typically the ones holding unflushed state.
      expect(released).toEqual(["location services"])
      expect(failures.map((f) => f.name)).toEqual(["model workers"])
    } finally {
      offBad()
      offGood()
    }
  })

  test("a clean run reports nothing, and unregistering really removes it", async () => {
    const off = registerDisposer("instance cache", async () => {})
    expect(await disposeInstance("/tmp/x")).toEqual([])
    off()
    // Negative control: with the entry gone, a disposer that would have thrown cannot be reached.
    const offThrow = registerDisposer("gone", async () => {
      throw new Error("should never run")
    })
    offThrow()
    expect(await disposeInstance("/tmp/x")).toEqual([])
  })

  test("two disposers registered under the same name are independent entries", async () => {
    // The registry keys on the ENTRY, not the name — otherwise registering "location services"
    // twice would silently drop one subsystem's cleanup.
    const seen: string[] = []
    const a = registerDisposer("dup", async () => void seen.push("a"))
    const b = registerDisposer("dup", async () => void seen.push("b"))
    try {
      await disposeInstance("/tmp/x")
      expect(seen.sort()).toEqual(["a", "b"])
    } finally {
      a()
      b()
    }
  })
})
