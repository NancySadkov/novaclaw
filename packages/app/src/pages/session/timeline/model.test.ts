import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@novaclaw/sdk/v2/client"
import { selectUserMessages, selectVisibleUserMessages } from "./model"

const user = (id: string) => ({ id, type: "user" }) as unknown as SessionMessage
const assistant = (id: string) => ({ id, type: "assistant" }) as unknown as SessionMessage

describe("timeline model", () => {
  test("selects users and applies the revert boundary", () => {
    const messages: SessionMessage[] = [user("msg_1"), assistant("msg_2"), user("msg_3"), user("msg_5")]
    const users = selectUserMessages(messages)

    expect(users.map((message) => message.id)).toEqual(["msg_1", "msg_3", "msg_5"])
    expect(selectVisibleUserMessages(users, "msg_5").map((message) => message.id)).toEqual(["msg_1", "msg_3"])
    expect(selectVisibleUserMessages(users)).toBe(users)
  })
})
