import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
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
