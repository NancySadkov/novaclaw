import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentLifecycle } from "./lifecycle"
import { SessionSchema } from "../session/schema"

const id = (value: string) => SessionSchema.ID.make(value)
const root = id("ses_root")
const child = id("ses_child")
const grandchild = id("ses_grandchild")

const session = (sessionID: SessionSchema.ID, result?: unknown) =>
  ({ id: sessionID, result, time: {} }) as SessionSchema.Info

describe("officer lifecycle propagation", () => {
  test("pause stops each officer root through the recursive execution seam", async () => {
    const interrupted: SessionSchema.ID[] = []
    await Effect.runPromise(
      AgentLifecycle.propagate(
        { agentID: "officer", paused: true },
        {
          roots: () => Effect.succeed([root]),
          get: () => Effect.succeed(undefined),
          children: () => Effect.succeed([]),
          attempt: () => Effect.succeed(undefined),
          interrupt: (sessionID) => Effect.sync(() => void interrupted.push(sessionID)),
          adopt: () => Effect.void,
        },
      ),
    )
    expect(interrupted).toEqual([root])
  })

  test("unpause resumes interrupted roots and every unfinished worker, but not completed limbs", async () => {
    const adopted: SessionSchema.ID[] = []
    const rows = new Map([
      [root, session(root)],
      [child, session(child)],
      [grandchild, session(grandchild, "done")],
    ])
    const branches = new Map([
      [root, [child]],
      [child, [grandchild]],
      // Corrupt ancestry must not turn unpause into an infinite walk.
      [grandchild, [root]],
    ])
    await Effect.runPromise(
      AgentLifecycle.propagate(
        { agentID: "officer", paused: false },
        {
          roots: () => Effect.succeed([root]),
          get: (sessionID) => Effect.succeed(rows.get(sessionID)),
          children: (sessionID) => Effect.succeed(branches.get(sessionID) ?? []),
          attempt: (sessionID) => Effect.succeed(sessionID === root ? ({ state: "interrupted" } as never) : undefined),
          interrupt: () => Effect.void,
          adopt: (sessionID) => Effect.sync(() => void adopted.push(sessionID)),
        },
      ),
    )
    expect(adopted).toEqual([root, child])
  })
})
