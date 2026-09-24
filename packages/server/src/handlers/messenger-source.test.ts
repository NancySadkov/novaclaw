import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { MessengerStore } from "@novaclaw/core/messenger/store"
import { Messenger } from "@novaclaw/schema/messenger"
import { declareChatSource } from "./messenger"

const accountID = "msa_source_test" as Messenger.AccountID

function fixture(owner: string | undefined, seen: boolean) {
  const writes: Array<{ chatID: string; access: Messenger.SourceAccess | undefined }> = []
  const store: Pick<MessengerStore.Interface, "getAccount" | "declareChatAccess"> = {
    getAccount: () =>
      Effect.succeed(owner === undefined ? undefined : ({ id: accountID, agentID: owner } as Messenger.AccountInfo)),
    declareChatAccess: (input) =>
      Effect.sync(() => {
        writes.push({ chatID: input.chatID, access: input.access })
        return seen
      }),
  }
  return { store, writes }
}

const input = (access: Messenger.SourceAccess | null) => ({ accountID, agentID: "nova", chatID: "room/2", access })

describe("messenger chat source declaration", () => {
  test("rejects an unknown account before writing", async () => {
    const { store, writes } = fixture(undefined, true)
    const error = await Effect.runPromise(Effect.flip(declareChatSource(store, input("public"))))
    expect(error).toMatchObject({ kind: "messenger_account_unknown" })
    expect(writes).toEqual([])
  })

  test("rejects another officer's account before writing", async () => {
    const { store, writes } = fixture("other", true)
    const error = await Effect.runPromise(Effect.flip(declareChatSource(store, input("public"))))
    expect(error).toMatchObject({ kind: "messenger_account_owner_mismatch" })
    expect(writes).toEqual([])
  })

  test("rejects an unseen chat", async () => {
    const { store } = fixture("nova", false)
    const error = await Effect.runPromise(Effect.flip(declareChatSource(store, input("public"))))
    expect(error).toMatchObject({ kind: "messenger_chat_unknown" })
  })

  test("sets and clears the user's declaration", async () => {
    const { store, writes } = fixture("nova", true)
    await Effect.runPromise(declareChatSource(store, input("public")))
    await Effect.runPromise(declareChatSource(store, input(null)))
    expect(writes).toEqual([
      { chatID: "room/2", access: "public" },
      { chatID: "room/2", access: undefined },
    ])
  })
})
