import { describe, expect, test } from "bun:test"
import type { NovaclawClient, SessionV2Info } from "@novaclaw/sdk/v2/client"
import { listDebugActiveSessions, listDebugSessions } from "./debug-process"

const session = (id: string): SessionV2Info =>
  ({
    id,
    slug: id,
    version: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    title: id,
    location: { directory: "/tmp" },
  }) as SessionV2Info

const fakeClient = (pages: Array<{ data: SessionV2Info[]; next?: string }>) => {
  const calls: Array<Record<string, unknown>> = []
  const client = {
    v2: {
      session: {
        list: async (query: Record<string, unknown>) => {
          calls.push(query)
          const page = pages[calls.length - 1]
          if (!page) throw new Error("unexpected page")
          return { data: { data: page.data, cursor: page.next === undefined ? {} : { next: page.next } } }
        },
        active: async () => ({ data: { data: { one: { type: "running" as const } } } }),
      },
    },
  } as unknown as NovaclawClient
  return { client, calls }
}

describe("the Debug process roster", () => {
  test("walks every server page instead of capping the actionable rows", async () => {
    const { client, calls } = fakeClient([
      { data: [session("one")], next: "page-2" },
      { data: [session("two")], next: "page-3" },
      { data: [session("three")] },
    ])

    await expect(listDebugSessions(client)).resolves.toHaveLength(3)
    expect(calls).toEqual([
      { limit: 200 },
      { limit: 200, cursor: "page-2" },
      { limit: 200, cursor: "page-3" },
    ])
  })

  test("refuses a repeated cursor instead of spinning forever", async () => {
    const { client } = fakeClient([
      { data: [session("one")], next: "same" },
      { data: [session("two")], next: "same" },
    ])

    await expect(listDebugSessions(client)).rejects.toThrow("repeated session-list cursor")
  })

  test("reads the server-owned active set for live process status", async () => {
    const { client } = fakeClient([{ data: [] }])
    await expect(listDebugActiveSessions(client)).resolves.toEqual({ one: { type: "running" } })
  })
})
