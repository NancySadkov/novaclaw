import { describe, expect } from "bun:test"
import { Effect } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { Messenger } from "@novaclaw/schema/messenger"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { MessengerStore } from "@novaclaw/core/messenger/store"
import { testEffect } from "./lib/effect"

// P0 gates (notes/messenger-plan.md §8): store CRUD round-trips, the one-session-per-chat
// constraint surfaces as a typed error naming the holder, cursors upsert, and account removal
// cascades to every dependent table.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, MessengerStore.node, FSUtil.node])))

describe("MessengerStore", () => {
  it.effect("accounts round-trip, patch, and list", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const account = yield* store.createAccount({
        driverID: "telegram",
        label: "Nova bot",
        enabled: true,
        settings: { probe: "yes" },
      })
      expect(account.id.startsWith("msa_")).toBe(true)
      expect(account.credentialID).toBeUndefined()

      const loaded = yield* store.getAccount(account.id)
      expect(loaded).toEqual(account)

      yield* store.updateAccount(account.id, { label: "Renamed", enabled: false })
      const renamed = yield* store.getAccount(account.id)
      expect(renamed?.label).toBe("Renamed")
      expect(renamed?.enabled).toBe(false)
      expect(renamed?.settings).toEqual({ probe: "yes" })

      expect((yield* store.listAccounts()).map((entry) => entry.id)).toContain(account.id)
      yield* store.removeAccount(account.id)
      expect(yield* store.getAccount(account.id)).toBeUndefined()
    }),
  )

  it.effect("seen-chat cache upserts (title/kind refresh, last_seen advances) and sorts newest-first", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const account = yield* store.createAccount({ driverID: "telegram", label: "t", enabled: true, settings: {} })
      yield* store.seenChat({ accountID: account.id, chatID: "42", kind: "dm", title: "Nancy", at: 100 })
      yield* store.seenChat({ accountID: account.id, chatID: "77", kind: "group", title: "Support", at: 300 })
      yield* store.seenChat({ accountID: account.id, chatID: "42", kind: "dm", title: "Nancy L", at: 200 })

      const chats = yield* store.listChats(account.id)
      expect(chats.map((chat) => chat.chatID)).toEqual(["77", "42"])
      expect(chats[1]?.title).toBe("Nancy L")
      expect(chats[1]?.lastSeen).toBe(200)

      // hasChat is the cold-start test (traffic rules §2.3): a seen chat is known, others aren't.
      expect(yield* store.hasChat(account.id, "42")).toBe(true)
      expect(yield* store.hasChat(account.id, "never-heard-of")).toBe(false)
    }),
  )

  it.effect("one session per chat: the second bind fails typed, naming the holder", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const account = yield* store.createAccount({ driverID: "telegram", label: "t", enabled: true, settings: {} })
      const binding = yield* store.createBinding({
        accountID: account.id,
        chatID: "42",
        sessionID: "ses_alpha",
        trust: "operator",
      })
      expect(binding.id.startsWith("msb_")).toBe(true)
      expect(binding.status).toBe("active")

      const second = yield* store
        .createBinding({ accountID: account.id, chatID: "42", sessionID: "ses_beta", trust: "client" })
        .pipe(Effect.flip)
      expect(second._tag).toBe("MessengerStore.ChatAlreadyBound")
      expect(second.sessionID).toBe("ses_alpha")

      // A different chat on the same account binds fine; a session may hold several chats.
      const other = yield* store.createBinding({
        accountID: account.id,
        chatID: "77",
        sessionID: "ses_alpha",
        trust: "audience",
      })
      expect((yield* store.bindingsForSession("ses_alpha")).map((entry) => entry.chatID).sort()).toEqual(["42", "77"])

      yield* store.setBindingStatus(other.id, "paused")
      expect((yield* store.bindingForChat(account.id, "77"))?.status).toBe("paused")

      yield* store.removeBinding(binding.id)
      expect(yield* store.bindingForChat(account.id, "42")).toBeUndefined()
    }),
  )

  it.effect("contacts upsert by (account, sender) and pairing state round-trips", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const account = yield* store.createAccount({ driverID: "irc", label: "t", enabled: true, settings: {} })
      yield* store.upsertContact({ accountID: account.id, senderID: "u1", name: "Stranger", trust: "client", pairedAt: undefined })
      yield* store.upsertContact({ accountID: account.id, senderID: "u1", name: "Nancy", trust: "operator", pairedAt: 500 })

      const contact = yield* store.getContact(account.id, "u1")
      expect(contact).toEqual({ accountID: account.id, senderID: "u1", name: "Nancy", trust: "operator", pairedAt: 500 })
      expect(yield* store.listContacts(account.id)).toHaveLength(1)

      yield* store.removeContact(account.id, "u1")
      expect(yield* store.getContact(account.id, "u1")).toBeUndefined()
    }),
  )

  it.effect("cursors upsert whole-value and read back", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const account = yield* store.createAccount({ driverID: "telegram", label: "t", enabled: true, settings: {} })
      expect(yield* store.getCursor(account.id)).toBeUndefined()
      yield* store.setCursor(account.id, { offset: 12 })
      yield* store.setCursor(account.id, { offset: 99 })
      expect(yield* store.getCursor(account.id)).toEqual({ offset: 99 })
    }),
  )

  // The guard read's fault behaviour, exercised against a REAL sqlite fault (the table is dropped
  // out from under it) rather than a stubbed `Effect.fail`. That distinction is the whole point:
  // this read ends every consumer's `orElseSucceed(() => [])`, and `orElseSucceed` catches a
  // failure but NOT a die — so while the implementation ended in `Effect.orDie`, a database fault
  // unwound the caller's fiber (the turn, or the gateway's instance-global relay) and the four
  // recoveries written for it were unreachable. See `host-exec.test.ts` for the other half.
  it.effect("bindingsForSession fails CLOSED and names the fault when the database is unreadable", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const { db } = yield* Database.Service
      const account = yield* store.createAccount({ driverID: "telegram", label: "t", enabled: true, settings: {} })
      yield* store.createBinding({ accountID: account.id, chatID: "1", sessionID: "ses_guard", trust: "client" })
      expect((yield* store.bindingsForSession("ses_guard")).map((entry) => entry.chatID)).toEqual(["1"])

      // A fault no caller can prevent: the table is gone. (`NOVACLAW_DB=:memory:` in the test
      // preload gives every test its own connection, so this cannot leak into another test.)
      yield* db.run("DROP TABLE messenger_binding")

      // …the read RETURNS rather than dying, so the consumers' fail-closed path is reachable.
      expect(yield* store.bindingsForSession("ses_guard")).toEqual([])

      // …and it is not a SILENT empty (standing decision 3): the subsystem names itself and the
      // cause. The default Effect logger writes through the Console service, which the test env
      // replaces with TestConsole, so this is the real log line the operator would get.
      const logged = (yield* TestConsole.logLines).map((line) => JSON.stringify(line)).join("\n")
      expect(logged).toContain("MessengerStore.bindingsForSession(ses_guard)")
      expect(logged).toContain("messenger_binding")
    }),
  )

  it.effect("removing an account cascades chats, contacts, bindings, and cursor", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const account = yield* store.createAccount({ driverID: "telegram", label: "t", enabled: true, settings: {} })
      yield* store.seenChat({ accountID: account.id, chatID: "1", kind: "dm", title: "x", at: 1 })
      yield* store.upsertContact({ accountID: account.id, senderID: "u", name: "x", trust: "client", pairedAt: undefined })
      yield* store.createBinding({ accountID: account.id, chatID: "1", sessionID: "ses_x", trust: "client" })
      yield* store.setCursor(account.id, 5)

      yield* store.removeAccount(account.id)
      expect(yield* store.listChats(account.id)).toEqual([])
      expect(yield* store.listContacts(account.id)).toEqual([])
      expect(yield* store.bindingsForAccount(account.id)).toEqual([])
      expect(yield* store.getCursor(account.id)).toBeUndefined()
      expect(yield* store.getAccount(account.id)).toBeUndefined()
    }),
  )
})

// Type-level guard: the wire Trust union stays the three user-facing tiers (§0.1).
const _trustCheck: readonly Messenger.Trust[] = ["operator", "client", "audience"]
void _trustCheck
