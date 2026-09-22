import { expect, test } from "bun:test"
import { clearOfficerChat } from "./session-clear-chat"

function fixture(options: { creation?: "throw" | "empty"; removeError?: boolean; empty?: boolean } = {}) {
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
