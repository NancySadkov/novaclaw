import { describe, expect, test } from "bun:test"
import { spawnRow } from "./spawn-row"

const t = ((key: string) => ({ "ui.transcript.tool.spawn": "Spawned a worker" })[key] ?? key) as never

describe("spawn transcript row", () => {
  test("names the worker and shows the delegated purpose when folded", () => {
    expect(spawnRow({ prompt: "Add the battle scene" }, t)).toEqual({
      title: "Spawned a worker",
      subtitle: "Add the battle scene",
    })
  })

  test("does not manufacture a purpose when the call has no decoded input yet", () => {
    expect(spawnRow({}, t)).toEqual({ title: "Spawned a worker" })
  })
})
