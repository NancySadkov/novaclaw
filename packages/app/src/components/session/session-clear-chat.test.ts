import { expect, test } from "bun:test"
import { clearOfficerChat } from "./session-clear-chat"

function fixture(
  options: {
    creation?: "throw" | "empty"
    removeError?: boolean
    /** Ids the server already has no row for — the state a retried Clear finds. */
    gone?: readonly string[]
    empty?: boolean
  } = {},
) {
  const calls: string[] = []
  /**
   * ⚠️ These are ROOTS of `theron` only, archived included — which is what
   * `GET /api/agent/{agentID}/chats` returns and what the client no longer computes. Another
   * agent's chat and a sub-agent's thread used to sit in this list and be filtered out HERE, by
   * `isRoot` and an agent comparison. That filtering is the instance's job now
   * (`RosterChat.allRootsFor`), so a fake that still returned them would be testing a filter the
   * product no longer performs; the proof that they are excluded now lives beside the query.
   */
  const rows = [
    { id: "old", title: "Old", directory: "/p", archived: 2 },
    { id: "live", title: "Live", directory: "/p", archived: null },
  ]
  const input = {
    agentID: "theron",
    name: "Theron",
    pathname: "/project/session/old",
    client: {
      agent: {
        chats: async () => ({ data: { data: options.empty ? [] : rows } }),
      },
      session: {
        remove: async ({ sessionID }: { sessionID: string }) => {
          calls.push(`remove:${sessionID}`)
          if (options.gone?.includes(sessionID))
            return { error: { _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` } }
          return options.removeError ? { error: new Error("remove failed") } : {}
        },
        create: async (value: Record<string, unknown>) => {
          calls.push(`create:${value.agent}`)
          if (options.creation === "throw") throw new Error("create failed")
          return options.creation === "empty" ? {} : { data: { data: { id: "fresh" } } }
        },
      },
    },
    onReplacementFailed: (sessionIDs: string[]) => calls.push(`cleanup:${sessionIDs.sort().join(",")}`),
  }
  return { calls, run: () => clearOfficerChat(input) }
}

test("clearing removes the viewed archived chat and every live root before opening its replacement", async () => {
  const operation = fixture()
  const cleared = await operation.run()
  // The removed ids are RETURNED so the caller can retire them client-side; relying on the
  // asynchronous `session.deleted` event is what left a ghost tab after a Clear (2026-09-22).
  expect(cleared?.successor).toBe("fresh")
  expect([...(cleared?.removed ?? [])].sort()).toEqual(["live", "old"])
  expect(operation.calls.slice(0, -1).sort()).toEqual(["remove:live", "remove:old"])
  expect(operation.calls.at(-1)).toBe("create:theron")
})

for (const creation of ["throw", "empty"] as const) {
  test(`a ${creation} replacement result cleans up deleted tabs before reporting failure`, async () => {
    const operation = fixture({ creation })
    await expect(operation.run()).rejects.toThrow()
    expect(operation.calls.at(-1)).toBe("cleanup:live,old")
  })
}

test("a failed deletion cannot create a successor or close the surviving chat", async () => {
  const operation = fixture({ removeError: true })
  await expect(operation.run()).rejects.toThrow("remove failed")
  expect(operation.calls.length).toBe(1)
  expect(operation.calls[0]?.startsWith("remove:")).toBe(true)
})

test("no matching conversation makes no writes", async () => {
  const operation = fixture({ empty: true })
  expect(await operation.run()).toBeUndefined()
  expect(operation.calls).toEqual([])
})

test("🔴 a chat the server has ALREADY removed is not reported as a failed clear", async () => {
  // Owner, 2026-09-26: Clear chat on Nova answered "Could not clear this chat: Session not found:
  // ses_nova" and the instance dropped its connection — while the removal had in fact happened. The
  // id list is read once, up front, so a retried or resumed Clear walks ids the first attempt already
  // deleted, and the second pass told the user their clear had failed when it had succeeded.
  const operation = fixture({ gone: ["old"] })
  const cleared = await operation.run()

  expect(cleared?.successor).toBe("fresh")
  // Reported as removed, because retiring the traces of a chat that is gone is the whole point.
  expect([...(cleared?.alreadyGone ?? [])]).toEqual(["old"])
  expect([...(cleared?.removed ?? [])].sort()).toEqual(["live", "old"])
  // …and the replacement was still opened, which is what the throw used to prevent.
  expect(operation.calls.at(-1)).toBe("create:theron")
})

test("a removal that fails for any OTHER reason still fails the clear", async () => {
  // The exemption is on the error's KIND, not its text: a clear that half-failed must still say so.
  const operation = fixture({ removeError: true })
  await expect(operation.run()).rejects.toThrow("remove failed")
  expect(operation.calls.length).toBe(1)
})

test("🔴 the clear removes EXACTLY what the instance named, including a filed chat", async () => {
  // The defect this replaced: the target list was folded from `GET /api/session`, whose default is the
  // newest 50 sessions, so a colleague with more history than one page had a Clear that removed part of
  // it and reported success. The list is now the instance's, and this pins that the client acts on all of
  // it — the FILED root included, which is the transcript a user is often reading when they clear.
  const removed: string[] = []
  const client = {
    agent: {
      chats: async () => ({
        data: {
          data: [
            { id: "ses_newest", title: "n", directory: "/p", archived: null },
            { id: "ses_filed", title: "f", directory: "/p", archived: 42 },
          ],
        },
      }),
    },
    session: {
      remove: async ({ sessionID }: { sessionID: string }) => {
        removed.push(sessionID)
        return {}
      },
      create: async () => ({ data: { data: { id: "ses_successor" } } }),
    },
  }
  const cleared = await clearOfficerChat({
    client: client as never,
    agentID: "theron",
    name: "Theron",
    pathname: "/project/session/ses_filed",
    onReplacementFailed: () => {},
  })
  expect([...(cleared?.removed ?? [])].sort()).toEqual(["ses_filed", "ses_newest"])
  expect(removed.sort()).toEqual(["ses_filed", "ses_newest"])
  expect(cleared?.successor).toBe("ses_successor")
})

test("an instance that answers with no list fails the clear rather than reporting nothing to do", async () => {
  // The most dangerous shape of this bug is silent: an empty target list means "there is nothing to
  // clear", the user is told their conversation is gone, and every transcript is still on disk. So a
  // 200 with no array is a FAULT, and it must not be smoothed into that answer.
  const client = {
    agent: { chats: async () => ({ data: { data: undefined } }) },
    session: {
      remove: async () => ({}),
      create: async () => ({ data: { data: { id: "ses_successor" } } }),
    },
  }
  await expect(
    clearOfficerChat({
      client: client as never,
      agentID: "theron",
      name: "Theron",
      pathname: "/project/session/old",
      onReplacementFailed: () => {},
    }),
  ).rejects.toBeDefined()
})
