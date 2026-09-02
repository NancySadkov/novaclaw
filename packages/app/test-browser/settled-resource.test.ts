import { describe, expect, test } from "bun:test"
import { createResource, createRoot, createSignal } from "solid-js"
import { answeredNothing, createSettledResource } from "@/utils/settled-resource"
import { createListState, listStateOf } from "@/utils/list-state"

/**
 * **The two helpers that make "empty" and "failed" different things, and the trap they replace.**
 *
 * 🔴 The first describe block is not a test of our code at all — it is a test of the belief the
 * whole design rests on. A previous sweep read `initialValue: []` as a guard and classified a dozen
 * unguarded reads as safe on the strength of it. That belief is checked here against the shipped
 * `solid-js`, so if a future version changes it, this file says so instead of the app doing it.
 */

/** Let queued microtasks and the resource's own `queueMicrotask` run. */
const settle = async (times = 4) => {
  for (let index = 0; index < times; index += 1) await new Promise((done) => setTimeout(done, 0))
}

describe("what a bare createResource actually does when its fetcher rejects", () => {
  test("the ACCESSOR throws — the failure is not where the fetcher is", async () => {
    await createRoot(async (dispose) => {
      const [resource] = createResource(
        () => 1,
        () => Promise.reject(new Error("the instance did not answer")),
      )
      await settle()
      expect(resource.state).toBe("errored")
      expect(() => resource()).toThrow("the instance did not answer")
      dispose()
    })
  })

  test("`.latest` throws too — DESPITE an initialValue, which is what made the pattern spread", async () => {
    // `resolved` is initialised to `"initialValue" in options`, and `.latest`'s getter re-throws
    // whenever `resolved` is set. So the spelling that READS as the safe one is not one, and a
    // viewer reaching for `.latest` to avoid a flash of undefined inherits the crash unchanged.
    await createRoot(async (dispose) => {
      const [resource] = createResource(
        () => 1,
        () => Promise.reject(new Error("still throws")),
        { initialValue: [] as string[] },
      )
      await settle()
      expect(() => resource.latest).toThrow("still throws")
      dispose()
    })
  })

  test("an initialValue also erases `not asked yet` — the resource is READY before anything runs", () => {
    createRoot((dispose) => {
      const [asked] = createResource(
        () => undefined,
        () => Promise.resolve(["x"]),
        { initialValue: [] as string[] },
      )
      const [unasked] = createResource(
        () => undefined,
        () => Promise.resolve(["x"]),
      )
      // Same situation, two different reports: with an initialValue a cold client is indistinguishable
      // from a server that answered with nothing.
      expect(asked.state).toBe("ready")
      expect(unasked.state).toBe("unresolved")
      dispose()
    })
  })
})

describe("createSettledResource", () => {
  test("a nullish source is idle — not loading, not failed, and it never asked", () => {
    createRoot((dispose) => {
      const [rows] = createSettledResource<string[], number>(
        () => undefined,
        () => Promise.resolve(["never"]),
      )
      expect(rows.state).toBe("idle")
      expect(rows.idle).toBe(true)
      expect(rows.loading).toBe(false)
      expect(rows.failed).toBe(false)
      expect(rows()).toBeUndefined()
      dispose()
    })
  })

  test("a rejecting fetcher becomes `failed`, and the accessor stays readable", async () => {
    await createRoot(async (dispose) => {
      const [rows] = createSettledResource<string[], number>(
        () => 1,
        () => Promise.reject(new Error("boom")),
      )
      expect(rows.state).toBe("loading")
      await settle()
      expect(rows.state).toBe("failed")
      expect(rows.failed).toBe(true)
      // The whole point: reading it is safe, so a render can decide what to say instead of throwing
      // past every local recovery affordance into the application's root boundary.
      expect(() => rows()).not.toThrow()
      expect(rows()).toBeUndefined()
      dispose()
    })
  })

  test("a fetcher that throws SYNCHRONOUSLY is caught too", async () => {
    // Solid catches this itself and marks the resource errored, so a `.catch` on the returned
    // promise never runs — the same dead end by a shorter route. The wrapper is `async`, which
    // turns the throw into a rejection it can see.
    await createRoot(async (dispose) => {
      const [rows] = createSettledResource<string[], number>(
        () => 1,
        () => {
          throw new Error("thrown before any promise existed")
        },
      )
      await settle()
      expect(rows.failed).toBe(true)
      expect(() => rows()).not.toThrow()
      dispose()
    })
  })

  test("a fetcher that RESOLVES to undefined is a success, not a failure", async () => {
    // The distinction the private sentinel exists for. Folding this together with a rejection would
    // rebuild the defect one layer down, inside the helper everyone is told to trust.
    await createRoot(async (dispose) => {
      const [value] = createSettledResource<string | undefined, number>(
        () => 1,
        () => Promise.resolve(undefined),
      )
      await settle()
      expect(value.failed).toBe(false)
      expect(value.state).toBe("ready")
      expect(value()).toBeUndefined()
      expect(answeredNothing(value)).toBe(true)
      dispose()
    })
  })

  test("an empty ARRAY is an answer — `answeredNothing` is false for it", async () => {
    await createRoot(async (dispose) => {
      const [rows] = createSettledResource<string[], number>(
        () => 1,
        () => Promise.resolve([]),
      )
      await settle()
      expect(rows.failed).toBe(false)
      expect(answeredNothing(rows)).toBe(false)
      dispose()
    })
  })

  test("failure is STICKY across a refetch, and clears when an answer arrives", async () => {
    await createRoot(async (dispose) => {
      const [attempt, setAttempt] = createSignal(1)
      const [rows] = createSettledResource<string[], number>(
        () => attempt(),
        (n) => (n === 1 ? Promise.reject(new Error("first")) : Promise.resolve(["ok"])),
      )
      await settle()
      expect(rows.failed).toBe(true)
      setAttempt(2)
      // Mid-flight the screen must not fall back through "loading" to something that reads as empty.
      expect(rows.failed).toBe(true)
      await settle()
      expect(rows.failed).toBe(false)
      expect(rows()).toEqual(["ok"])
      dispose()
    })
  })
})

describe("listStateOf — the three-state result, as a pure function", () => {
  test("failed outranks everything, so a retry never shows an empty screen", () => {
    expect(listStateOf({ failed: true, loading: true, idle: true, items: [] })).toEqual({ kind: "failed" })
  })

  test("loading outranks idle, and idle outranks the items", () => {
    expect(listStateOf({ loading: true, idle: true, items: [] })).toEqual({ kind: "loading" })
    expect(listStateOf({ idle: true, items: [] })).toEqual({ kind: "idle" })
  })

  test("an empty ARRAY is empty; a settled `undefined` is FAILED, never empty", () => {
    expect(listStateOf({ items: [] })).toEqual({ kind: "empty" })
    expect(listStateOf({ items: undefined })).toEqual({ kind: "failed" })
  })

  test("items are handed through on the loaded arm", () => {
    expect(listStateOf({ items: ["a", "b"] })).toEqual({ kind: "loaded", items: ["a", "b"] })
  })
})

describe("createListState", () => {
  test("a failed resource is `failed`; an empty answer is `empty`", async () => {
    await createRoot(async (dispose) => {
      const [broken] = createSettledResource<string[], number>(
        () => 1,
        () => Promise.reject(new Error("no")),
      )
      const [emptyRows] = createSettledResource<string[], number>(
        () => 1,
        () => Promise.resolve([]),
      )
      const brokenState = createListState<string>(broken)
      const emptyState = createListState<string>(emptyRows)
      await settle()
      expect(brokenState().kind).toBe("failed")
      expect(emptyState().kind).toBe("empty")
      dispose()
    })
  })

  test("`failedWhen` reports an UPSTREAM fault instead of a spinner that never resolves", async () => {
    // The live shape: a prerequisite read that answers with a falsy placeholder rather than
    // rejecting. Without this the list sits at `idle` forever, which is the same false claim as an
    // empty list wearing a loading animation.
    await createRoot(async (dispose) => {
      const [directory] = createSettledResource<string, number>(
        () => 1,
        () => Promise.resolve(""),
      )
      const [rows] = createSettledResource<string[], string>(
        () => directory() || undefined,
        (d) => Promise.resolve([d]),
      )
      const plain = createListState<string>(rows)
      const guarded = createListState<string>(rows, { failedWhen: () => answeredNothing(directory) })
      await settle()
      expect(plain().kind).toBe("idle")
      expect(guarded().kind).toBe("failed")
      dispose()
    })
  })

  test("`items` renders a DERIVED view without losing the underlying failure", async () => {
    await createRoot(async (dispose) => {
      const [rows] = createSettledResource<string[], number>(
        () => 1,
        () => Promise.resolve(["alpha", "beta"]),
      )
      const filtered = createListState<string>(rows, { items: () => (rows() ?? []).filter((r) => r === "beta") })
      await settle()
      expect(filtered()).toEqual({ kind: "loaded", items: ["beta"] })
      dispose()
    })
  })
})
