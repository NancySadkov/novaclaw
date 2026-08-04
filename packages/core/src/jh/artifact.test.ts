import { describe, expect, test } from "bun:test"
import type { JhStep } from "./step"
import { JhArtifact } from "./artifact"

const ref = (id: string, type: JhStep.ArtifactType = "file"): JhStep.ArtifactRef => ({ id, type })

describe("JhArtifact.memory", () => {
  test("put/get round-trip", () => {
    const store = JhArtifact.memory()
    const stored = store.put(ref("add.c"), "int add(){}")
    expect(stored).toMatchObject({ id: "add.c", type: "file", content: "int add(){}" })
    expect(store.get("add.c")).toEqual(stored)
  })

  test("same content → same hash; different content → different hash", () => {
    const store = JhArtifact.memory()
    const a = store.put(ref("a"), "same")
    const b = store.put(ref("b"), "same")
    const c = store.put(ref("c"), "different")
    expect(a.hash).toBe(b.hash)
    expect(a.hash).not.toBe(c.hash)
  })

  test("overwrite updates content and hash (latest wins)", () => {
    const store = JhArtifact.memory()
    const first = store.put(ref("x"), "one")
    const second = store.put(ref("x"), "two")
    expect(store.get("x")).toEqual(second)
    expect(second.content).toBe("two")
    expect(second.hash).not.toBe(first.hash)
    expect([...store.ids()]).toEqual(["x"]) // still one id
  })

  test("has and ids", () => {
    const store = JhArtifact.memory()
    store.put(ref("a"), "1")
    store.put(ref("b"), "2")
    expect(store.has("a")).toBe(true)
    expect(store.has("missing")).toBe(false)
    expect(store.ids()).toEqual(new Set(["a", "b"]))
  })

  test("memory(seed) restores prior state", () => {
    const seed: JhArtifact.Stored[] = [{ id: "s", type: "note", hash: "deadbeef", content: "seeded" }]
    const store = JhArtifact.memory(seed)
    expect(store.get("s")).toEqual(seed[0]!)
    expect(store.snapshot()).toEqual(seed)
  })

  test("get missing → undefined", () => {
    expect(JhArtifact.memory().get("nope")).toBeUndefined()
  })
})
