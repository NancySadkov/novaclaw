import { describe, expect, test } from "bun:test"
import type { MemoryRow } from "@/utils/memory-api"
import { buildMemorySpace, colorForKind, detailLevel } from "./model"

const row = (id: string, kind = "passage", name: string | null = "New session"): MemoryRow => ({
  id,
  kind,
  name,
  text: `memory ${id}`,
  scope: "agent:daedalus",
  source: null,
  confidence: null,
  relation: "about",
  status: "active",
  subject: null,
  predicate: null,
  conflictKey: null,
  supersededBy: null,
  evidence: null,
  evidenceKind: null,
})

describe("memory space model", () => {
  test("all 504 unlinked passage memories become visible stars in navigable regions", () => {
    const rows = Array.from({ length: 504 }, (_, index) => row(`p${index.toString().padStart(3, "0")}`))
    const space = buildMemorySpace(rows, [])

    expect(space.points).toHaveLength(504)
    expect(space.clusters).toHaveLength(7)
    expect(space.clusters.reduce((total, cluster) => total + cluster.count, 0)).toBe(504)
    expect(space.edges).toHaveLength(0)
    expect(new Set(space.points.map((point) => point.position.x)).size).toBeGreaterThan(450)
  })

  test("layout is deterministic regardless of server row order", () => {
    const rows = [row("c", "claim"), row("a", "entity"), row("b", "episode")]
    const edges = [{ from: "a", to: "b", type: "mentions" }]
    const first = buildMemorySpace(rows, edges)
    const second = buildMemorySpace([...rows].reverse(), edges)

    expect(second).toEqual(first)
  })

  test("stored edges create a connected region without inventing links for orphans", () => {
    const space = buildMemorySpace(
      [row("a", "entity", "A"), row("b", "claim", "B"), row("c", "passage", "C")],
      [{ from: "a", to: "b", type: "about" }],
    )

    expect(space.edges).toEqual([{ from: 0, to: 1, type: "about" }])
    expect(space.clusters).toHaveLength(2)
    expect(space.points.find((point) => point.id === "c")?.degree).toBe(0)
  })

  test("zoom owns progressive disclosure", () => {
    expect(detailLevel(0.9)).toBe("atlas")
    expect(detailLevel(2)).toBe("systems")
    expect(detailLevel(4)).toBe("memories")
  })

  test("a future memory kind still receives a visible colour", () => {
    expect(colorForKind("future-kind")).toEqual([0.73, 0.66, 0.75])
  })
})
