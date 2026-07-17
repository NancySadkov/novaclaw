import { describe, expect, test } from "bun:test"
import type { NovaclawClient, SessionV2Info as Session } from "@novaclaw/sdk/v2/client"
import { createServerSession } from "./server-session"

const session = (id: string, parentID?: string): Session =>
  ({
    id,
    projectID: "project",
    location: { directory: "/repo" },
    title: id,
    parentID,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }) as unknown as Session

function setup(sessions: Record<string, Session>) {
  const get: unknown[] = []
  const client = {
    v2: {
      session: {
        get: async (input: unknown) => {
          get.push(input)
          const id = (input as { sessionID: string }).sessionID
          return { data: sessions[id] ? { data: sessions[id] } : undefined }
        },
        todo: async () => ({ data: { data: [] } }),
      },
    },
  } as unknown as NovaclawClient
  return { get, store: createServerSession(client) }
}

describe("server session", () => {
  test("resolves lineage by session ID without directory", async () => {
    const ctx = setup({ child: session("child", "root"), root: session("root") })

    const result = await ctx.store.lineage.resolve("child")

    expect(result.root.id).toBe("root")
    expect(ctx.get).toEqual([{ sessionID: "child" }, { sessionID: "root" }])
    expect(ctx.store.lineage.peek("child")).toEqual(result)
  })

  test("loads session info through the server client", async () => {
    const ctx = setup({ root: session("root") })

    await ctx.store.sync("root")

    expect(ctx.get).toEqual([{ sessionID: "root" }])
    expect(ctx.store.get("root")?.id).toBe("root")
  })

  test("does not re-fetch cached session info", async () => {
    const ctx = setup({ root: session("root") })

    await ctx.store.sync("root")
    await ctx.store.sync("root")

    expect(ctx.get).toEqual([{ sessionID: "root" }])
  })

  test("force re-fetches cached session info", async () => {
    const ctx = setup({ root: session("root") })

    await ctx.store.sync("root")
    await ctx.store.sync("root", { force: true })

    expect(ctx.get).toEqual([{ sessionID: "root" }, { sessionID: "root" }])
  })

  test("applies events without a directory store", () => {
    const ctx = setup({})
    ctx.store.apply({ type: "session.created", properties: { sessionID: "root", info: session("root") } })
    ctx.store.apply({ type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } })

    expect(ctx.store.get("root")?.location.directory).toBe("/repo")
    expect(ctx.store.data.session_working("root")).toBe(true)
    expect(ctx.get).toEqual([])
  })

  test("preserves pinned session info under server-wide cache pressure", () => {
    const ctx = setup({})
    ctx.store.pin("active")
    ctx.store.apply({ type: "session.created", properties: { sessionID: "active", info: session("active") } })
    ctx.store.apply({ type: "session.status", properties: { sessionID: "active", status: { type: "busy" } } })

    for (let index = 0; index < 50; index++) {
      ctx.store.remember(session(`session-${index}`))
      ctx.store.apply({
        type: "session.status",
        properties: { sessionID: `session-${index}`, status: { type: "idle" } },
      })
    }

    expect(ctx.store.get("active")?.id).toBe("active")
    expect(ctx.store.data.session_status["session-0"]).toBeUndefined()
  })
})
