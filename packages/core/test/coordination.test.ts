import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { Coordination } from "@novaclaw/core/coordination"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))

const agent = (id: string, superior?: string, name?: string): AgentV2.Info =>
  ({
    id: AgentV2.ID.make(id),
    request: { headers: {}, body: {} },
    mode: "all",
    hidden: false,
    permissions: [],
    ...(superior === undefined ? {} : { superior: AgentV2.ID.make(superior) }),
    ...(name === undefined ? {} : { name }),
  }) as AgentV2.Info

const roster = [
  agent("nova", undefined, "Nova"),
  agent("xenia", "nova", "Xenia"),
  agent("geryon", "xenia", "Geryon"),
  agent("theron", "xenia", "Theron"),
]

describe("Coordination — the pure board", () => {
  test("`none set yet` is the one spelling for no task", () => {
    expect(Coordination.taskOrNone(undefined)).toBe("none set yet")
    expect(Coordination.taskOrNone("")).toBe("none set yet")
    expect(Coordination.taskOrNone("   ")).toBe("none set yet")
    expect(Coordination.taskOrNone("  review the handshake  ")).toBe("review the handshake")
  })

  test("a supervisor's board is the supervisor and its direct reports", () => {
    const tasks = new Map([["xenia", "organizing the migration"]])
    const board = Coordination.supervisorBoard(roster, tasks, "xenia")
    expect(board.map((entry) => String(entry.agent))).toEqual(["xenia", "geryon", "theron"])
    expect(board[0]?.task).toBe("organizing the migration")
    expect(board[1]?.task).toBeUndefined()
  })

  test("an officer's team board is itself, its superior, its peers and its reports", () => {
    const board = Coordination.teamBoard(roster, new Map(), "geryon")
    expect(board.map((entry) => String(entry.agent))).toEqual(["xenia", "geryon", "theron"])
  })

  test("a superior with team coordination off is marked, an unset one is on", () => {
    const board = Coordination.supervisorBoard(
      roster.map((item) => (String(item.id) === "xenia" ? { ...item, teamCoordination: false } : item)),
      new Map(),
      "xenia",
    )
    expect(board[0]?.teamCoordination).toBe(false)
    expect(board[1]?.teamCoordination).toBe(true)
  })

  test("format renders every officer with their task, and names the reader", () => {
    const tasks = new Map([["theron", "reviewing the P2P handshake"]])
    const text = Coordination.format(Coordination.supervisorBoard(roster, tasks, "xenia"), "theron")
    expect(text).toContain("xenia - Xenia: none set yet")
    expect(text).toContain("theron - Theron (you): reviewing the P2P handshake")
  })
})

describe("Coordination — the durable store", () => {
  it.effect("sets, replaces and clears an officer's task, and reads a batch", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* Coordination.put(db, "theron", "reviewing the P2P handshake")
      expect(yield* Coordination.get(db, "theron")).toBe("reviewing the P2P handshake")

      // A second declaration REPLACES rather than appends — one line per colleague.
      yield* Coordination.put(db, "theron", "writing the migration")
      expect(yield* Coordination.get(db, "theron")).toBe("writing the migration")

      yield* Coordination.put(db, "geryon", "drafting the parser")
      const tasks = yield* Coordination.taskMap(db, ["theron", "geryon", "xenia"])
      expect(tasks.get("theron")).toBe("writing the migration")
      expect(tasks.get("geryon")).toBe("drafting the parser")
      expect(tasks.has("xenia")).toBe(false)

      yield* Coordination.remove(db, "theron")
      expect(yield* Coordination.get(db, "theron")).toBeUndefined()
      // CONTROL — clearing one officer leaves the other untouched.
      expect(yield* Coordination.get(db, "geryon")).toBe("drafting the parser")
    }),
  )
})
