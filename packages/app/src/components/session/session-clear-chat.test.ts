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
  const rows = [
    { id: "old", agent: "theron", time: { created: 1, archived: 2 } },
    { id: "live", agent: "theron", time: { created: 3 } },
    { id: "other", agent: "nova", time: { created: 1 } },
    { id: "child", agent: "theron", parentID: "live", time: { created: 4 } },
  ]
  const input = {
    agentID: "theron",
    name: "Theron",
    pathname: "/project/session/old",
    client: {
      session: {
        list: async () => ({ data: { data: options.empty ? [] : rows } }),
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
