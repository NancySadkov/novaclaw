import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import { InstanceFetchError } from "@/utils/instance-fetch"
import { memoryClearScopeVerified, memoryEraseVerified, memoryExport, memoryProtection } from "@/utils/memory-api"

const server: ServerConnection.HttpBase = { url: "http://instance.test:4096" }
const realFetch = globalThis.fetch
const seen: Array<{ path: string; body: unknown }> = []
let answer: (path: string, body: unknown) => Response

globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const path = new URL(String(input)).pathname
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
  seen.push({ path, body })
  return answer(path, body)
}) as unknown as typeof globalThis.fetch

beforeEach(() => {
  seen.length = 0
  answer = () => Response.json({ message: "unhandled test route" }, { status: 500 })
})

afterAll(() => {
  globalThis.fetch = realFetch
})

describe("the strict memory export and erase client", () => {
  test("distinguishes an unavailable export from an authoritatively empty one", async () => {
    answer = () => Response.json([])
    await expect(memoryExport(server, { directory: "C:/work" })).resolves.toEqual([])

    answer = () => Response.json({ message: "memory store is unavailable" }, { status: 400 })
    await expect(memoryExport(server, { directory: "C:/work" })).rejects.toBeInstanceOf(InstanceFetchError)
  })

  test("returns the exact committed count only after an authoritative empty-store read", async () => {
    answer = (path, body) => {
      if (path === "/api/memory/erase") return Response.json(2_743)
      if (path === "/api/memory/export" && (body as { includeInvalid?: boolean }).includeInvalid === true)
        return Response.json([])
      return Response.json({ message: "wrong request" }, { status: 500 })
    }

    await expect(memoryEraseVerified(server, { directory: "C:/work" })).resolves.toBe(2_743)
    expect(seen).toEqual([
      { path: "/api/memory/erase", body: undefined },
      { path: "/api/memory/export", body: { includeInvalid: true } },
    ])
  })

  test("rejects when the final authoritative read still finds rows", async () => {
    answer = (path) => (path === "/api/memory/erase" ? Response.json(7) : Response.json([{ id: "mem_left_behind" }]))

    await expect(memoryEraseVerified(server, { directory: "C:/work" })).rejects.toThrow(
      "Memory erase left 1 rows in the store",
    )
  })
})

describe("scoped clear propagation", () => {
  test("rejects both a false result and a server fault", async () => {
    answer = () => Response.json(false)
    await expect(memoryClearScopeVerified(server, { directory: "C:/work", scope: "session:chat" })).rejects.toThrow(
      "was not cleared",
    )

    answer = () => Response.json({ message: "scope transaction rolled back" }, { status: 400 })
    await expect(
      memoryClearScopeVerified(server, { directory: "C:/work", scope: "session:chat" }),
    ).rejects.toBeInstanceOf(InstanceFetchError)
  })
})

test("protection reads batch every id without treating a truncated answer as unprotected", async () => {
  const ids = Array.from({ length: 501 }, (_, index) => `id_${index}`)
  answer = (_path, body) =>
    Response.json((body as { ids: string[] }).ids.map((id) => ({ id, protected: id === "id_500" })))
  const states = await memoryProtection(server, { directory: "C:/work", ids })
  expect(states.size).toBe(501)
  expect(states.get("id_500")).toBe(true)
  expect(seen.map((call) => (call.body as { ids: string[] }).ids.length)).toEqual([500, 1])
  answer = () => Response.json([])
  await expect(memoryProtection(server, { directory: "C:/work", ids: ["missing"] })).rejects.toThrow("Incomplete")
})
