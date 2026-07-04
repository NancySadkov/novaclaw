import { describe, expect, test } from "bun:test"
import type { NovaclawClient, SessionMessage } from "@novaclaw/sdk/v2/client"
import { fetchNativeMessages } from "./message-v2-fetch"

function fakeClient(body: unknown, capture?: (params: unknown) => void): NovaclawClient {
  return {
    v2: {
      session: {
        async messages(params: unknown) {
          capture?.(params)
          return { data: body }
        },
      },
    },
  } as unknown as NovaclawClient
}

describe("fetchNativeMessages", () => {
  test("unwraps response.data.data into SessionMessage[]", async () => {
    const messages = [{ id: "msg_1", type: "user", text: "hi", time: { created: 1 } }] as SessionMessage[]
    const result = await fetchNativeMessages(fakeClient({ data: messages }), "s_1")
    expect(result).toEqual(messages)
  })

  test("passes sessionID + pagination options through to the client", async () => {
    let seen: unknown
    await fetchNativeMessages(fakeClient({ data: [] }, (p) => (seen = p)), "s_1", {
      limit: 50,
      order: "desc",
      cursor: "c1",
    })
    expect(seen).toEqual({ sessionID: "s_1", limit: 50, order: "desc", cursor: "c1" })
  })

  test("returns [] when the response carries no data", async () => {
    expect(await fetchNativeMessages(fakeClient(undefined), "s_1")).toEqual([])
  })
})
