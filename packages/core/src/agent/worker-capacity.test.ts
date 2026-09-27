import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { AgentV2 } from "../agent"
import { AgentWorkerCapacity } from "./worker-capacity"
import { SessionSchema } from "../session/schema"
import { WorkerPurpose } from "../session/worker-purpose"

const id = (value: string) => SessionSchema.ID.make(value)
const root = id("ses_root")
const row = (name: string, parentID: SessionSchema.ID, created: number, result: unknown = null) => ({
  id: id(`ses_${name}`),
  parentID,
  result,
  archived: null as number | null,
  created,
  title: name,
  metadata: { [WorkerPurpose.KEY]: `task ${name}` },
})

describe("officer worker capacity", () => {
  test("a lower limit stops newest workers immediately and tells the officer exactly which", async () => {
    const workers = [row("old", root, 1), row("middle", root, 2), row("new", root, 3)]
    const killed: string[] = []
    const messages: string[] = []
    await Effect.runPromise(
      AgentWorkerCapacity.enforce(
        { agentID: "nova", limit: 1 },
        {
          roots: () => Effect.succeed([root]),
          limit: () => Effect.succeed(1),
          rows: () => Effect.succeed(workers),
          kill: (_parentID, childID) =>
            Effect.sync(() => {
              const worker = workers.find((entry) => entry.id === childID)!
              worker.archived = 1
              killed.push(childID)
              return 1
            }),
          notify: (_rootID, message) => Effect.sync(() => void messages.push(message)),
        },
        {},
      ),
    )
    expect(killed).toEqual([id("ses_new"), id("ses_middle")])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("ses_new · new · task new")
    expect(messages[0]).toContain("ses_middle · middle · task middle")
    expect(messages[0]).not.toContain("ses_old")
  })

  test("completed or archived workers do not consume capacity, even through an archived ancestor", async () => {
    const ancestor = row("archived", root, 1)
    ancestor.archived = 1
    const live = row("live", ancestor.id, 2)
    const completed = row("done", root, 3, "done")
    expect(AgentWorkerCapacity.activeDescendants(root, [ancestor, live, completed])).toEqual([live])
  })

  /**
   * 🔴 **The SHIPPED ceiling is per officer, and Nova's is zero** (owner, 2026-09-27: *"ensure that
   * Nova by default can spawn 0 workers (it can't spawn), since its job is delegating to named
   * agents"*).
   *
   * ⚠️ The order of these four IS the contract, and each case is the one that would pass if the next
   * `??` were written in the wrong place. A test that only asserted `limitFor("nova", undefined) === 0`
   * would still be green with the user override dropped on the floor, and the user override is the half
   * that makes this a default rather than a cage.
   */
  describe("the effective ceiling", () => {
    test("NOVA ships with NO worker budget", () => {
      expect(AgentWorkerCapacity.SHIPPED_MAX_WORKERS[AgentV2.NOVA_ID]).toBe(0)
      expect(AgentWorkerCapacity.limitFor(AgentV2.NOVA_ID, undefined)).toBe(0)
    })

    test("a user setting WINS over the shipped value — this is a default, not a cage", () => {
      expect(AgentWorkerCapacity.limitFor(AgentV2.NOVA_ID, { maxWorkers: 4 })).toBe(4)
      // Including zero: an operator who wants the CEO to have no workers after having had some must be
      // able to say so, and a `||` instead of `??` here would silently keep the old value.
      expect(AgentWorkerCapacity.limitFor(AgentV2.NOVA_ID, { maxWorkers: 0 })).toBe(0)
    })

    test("every OTHER officer still gets the instance default", () => {
      // The control: a shipped table must not become a global default in disguise.
      expect(AgentWorkerCapacity.limitFor("daedalus", undefined)).toBe(AgentWorkerCapacity.DEFAULT_MAX_WORKERS)
      expect(AgentWorkerCapacity.limitFor("daedalus", { maxWorkers: 2 })).toBe(2)
      // And an id nobody ships a ceiling for is not a special case — including one that looks like Nova.
      expect(AgentWorkerCapacity.limitFor("nova-clone", undefined)).toBe(
        AgentWorkerCapacity.DEFAULT_MAX_WORKERS,
      )
    })
  })

  test("a failed stop reports workers already terminated and does not spin", async () => {
    const workers = [row("old", root, 1), row("middle", root, 2), row("new", root, 3)]
    const messages: string[] = []
    const outcome = await Effect.runPromiseExit(
      AgentWorkerCapacity.enforce(
        { agentID: "nova", limit: 1 },
        {
          roots: () => Effect.succeed([root]),
          limit: () => Effect.succeed(1),
          rows: () => Effect.succeed(workers),
          kill: (_parentID, childID) => Effect.sync(() => {
            if (childID !== id("ses_new")) return undefined
            workers[2]!.archived = 1
            return 1
          }),
          notify: (_rootID, message) => Effect.sync(() => void messages.push(message)),
        },
        {},
      ),
    )
    expect(Exit.isFailure(outcome)).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("ses_new")
    expect(messages[0]).not.toContain("ses_middle")
  })
})
