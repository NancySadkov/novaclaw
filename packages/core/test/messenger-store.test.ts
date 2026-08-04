import { describe, expect } from "bun:test"
import { Effect } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { Messenger } from "@novaclaw/schema/messenger"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FSUtil } from "@novaclaw/core/fs-util"
import { MessengerStore } from "@novaclaw/core/messenger/store"
import { SessionSchema } from "@novaclaw/core/session/schema"
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
      yield* store.upsertContact({
        accountID: account.id,
        senderID: "u1",
        name: "Stranger",
        trust: "client",
        pairedAt: undefined,
      })
      yield* store.upsertContact({
        accountID: account.id,
        senderID: "u1",
        name: "Nancy",
        trust: "operator",
        pairedAt: 500,
      })

      const contact = yield* store.getContact(account.id, "u1")
      expect(contact).toEqual({
        accountID: account.id,
        senderID: "u1",
        name: "Nancy",
        trust: "operator",
        pairedAt: 500,
      })
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
  // `orElseSucceed` catches a failure but NOT a die — so while the implementation ended in
  // `Effect.orDie`, a database fault unwound the caller's fiber (the turn, or the gateway's
  // instance-global relay) and the four recoveries written for it were unreachable.
  //
  // ⚠️ The name of this test used to say "fails CLOSED", and that had become FALSE. Wave 1 made the
  // read succeed with `[]`, which is fail-closed for three consumers (no relay, no binding shown,
  // nothing to disconnect) and PERMISSIVE for the fourth: `host-exec.ts`'s containment walk read
  // `[]` as "no untrusted chat drives this turn" and ran `bash` raw instead of confined. So the
  // read now NAMES the fault and FAILS TYPED — the only shape that lets four consumers who need
  // different things all get the right one. See `host-exec.test.ts` for what the guard does with it.
  it.effect("bindingsForSession reports the fault typed — it never answers `[]` for a read it could not do", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const { db } = yield* Database.Service
      const account = yield* store.createAccount({ driverID: "telegram", label: "t", enabled: true, settings: {} })
      yield* store.createBinding({ accountID: account.id, chatID: "1", sessionID: "ses_guard", trust: "client" })
      expect((yield* store.bindingsForSession("ses_guard")).map((entry) => entry.chatID)).toEqual(["1"])

      // A fault no caller can prevent: the table is gone. (`NOVACLAW_DB=:memory:` in the test
      // preload gives every test its own connection, so this cannot leak into another test.)
      yield* db.run("DROP TABLE messenger_binding")

      // …the read FAILS (it does not die, so the consumers' recoveries stay reachable) and the
      // failure is typed and self-describing rather than an empty answer nobody can distinguish
      // from a session that genuinely holds no bindings.
      const failure = yield* store.bindingsForSession("ses_guard").pipe(Effect.flip)
      expect(failure._tag).toBe("MessengerStore.Unavailable")
      expect(failure.read).toBe("bindingsForSession(ses_guard)")
      expect(failure.detail).toContain("messenger_binding")

      // …and it is not a SILENT fault either (standing decision 3): the subsystem names itself and
      // the cause. The default Effect logger writes through the Console service, which the test env
      // replaces with TestConsole, so this is the real log line the operator would get.
      const logged = (yield* TestConsole.logLines).map((line) => JSON.stringify(line)).join("\n")
      expect(logged).toContain("messenger.store.read.failed")
      expect(logged).toContain('"messenger.operation":"bindingsForSession(ses_guard)"')
      expect(logged).toContain("messenger_binding")
    }),
  )

  // The three consumers that genuinely want an empty answer keep it, with ONE line each and no
  // signature change — `Effect.orElseSucceed(() => [])` was already written at every one of them
  // (gateway.ts's relay, the `messenger` tool's status and disconnect ops) back when this read was
  // fallible. This asserts that recovery still works against the real fault, so "no ripple" is a
  // measurement rather than a claim.
  it.effect("…and the fail-closed-to-empty consumers still get their empty, unchanged", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const { db } = yield* Database.Service
      const account = yield* store.createAccount({ driverID: "telegram", label: "t", enabled: true, settings: {} })
      yield* store.createBinding({ accountID: account.id, chatID: "1", sessionID: "ses_relay", trust: "client" })
      yield* db.run("DROP TABLE messenger_binding")

      const bound = yield* store.bindingsForSession("ses_relay").pipe(Effect.orElseSucceed(() => []))
      expect(bound).toEqual([])
    }),
  )

  // The same dead-letter class, three more places (v0.2.0-prep, batch 3). Each of these was
  // `Effect.orDie` under an `orElseSucceed` whose fallback is a STATEMENT, not an absence:
  // `listAccounts` → "No messenger accounts are set up. Ask the user to add one" (a claim about
  // the user's setup) and, in the gateway's reconcile, the cue to disconnect every live account;
  // `hasChat` → "This chat has never messaged us" (a claim about the correspondent);
  // `bindingForChat` → "This chat isn't driving any session" (a claim about the session — and the
  // read a self-chat MINTS a new console session on the strength of).
  //
  // Driven against a REAL sqlite fault, not a stubbed `Effect.fail`, because the distinction is
  // the whole point: while these ended in `orDie`, a fault was a DEFECT, so every `orElseSucceed`
  // written for them was unreachable and the fiber died instead. `Effect.flip` below only succeeds
  // for a typed failure — a die propagates through it and fails the test, which is exactly how
  // this test bites if the `nameTheFault` calls are reverted.
  it.effect("listAccounts, hasChat and bindingForChat fail typed — none of them invents an answer", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const { db } = yield* Database.Service
      const account = yield* store.createAccount({ driverID: "telegram", label: "t", enabled: true, settings: {} })
      yield* store.seenChat({ accountID: account.id, chatID: "9", kind: "dm", title: "Nancy", at: 1 })
      yield* store.createBinding({ accountID: account.id, chatID: "9", sessionID: "ses_dead", trust: "client" })

      // The positive control, first: with the tables intact each read answers, so the assertions
      // below are about the FAULT and not about the read being broken outright.
      expect((yield* store.listAccounts()).map((entry) => entry.id)).toContain(account.id)
      expect(yield* store.hasChat(account.id, "9")).toBe(true)
      expect((yield* store.bindingForChat(account.id, "9"))?.sessionID).toBe(SessionSchema.ID.make("ses_dead"))

      yield* db.run("DROP TABLE messenger_account")
      yield* db.run("DROP TABLE messenger_chat")
      yield* db.run("DROP TABLE messenger_binding")

      const accounts = yield* store.listAccounts().pipe(Effect.flip)
      expect(accounts._tag).toBe("MessengerStore.Unavailable")
      expect(accounts.read).toBe("listAccounts()")
      expect(accounts.detail).toContain("messenger_account")

      const chat = yield* store.hasChat(account.id, "9").pipe(Effect.flip)
      expect(chat._tag).toBe("MessengerStore.Unavailable")
      expect(chat.read).toBe(`hasChat(${account.id}, 9)`)
      expect(chat.detail).toContain("messenger_chat")

      const binding = yield* store.bindingForChat(account.id, "9").pipe(Effect.flip)
      expect(binding._tag).toBe("MessengerStore.Unavailable")
      expect(binding.read).toBe(`bindingForChat(${account.id}, 9)`)
      expect(binding.detail).toContain("messenger_binding")

      // …and none of the three is silent about it (ruling 2: the subsystem NAMES itself).
      const logged = (yield* TestConsole.logLines).map((line) => JSON.stringify(line)).join("\n")
      expect(logged).toContain("messenger.store.read.failed")
      expect(logged).toContain('"messenger.operation":"listAccounts()"')
      expect(logged).toContain('"messenger.operation":"hasChat(')
      expect(logged).toContain('"messenger.operation":"bindingForChat(')
    }),
  )

  // The consumer-facing half of `attempted`: it must be impossible to use the result WITHOUT having
  // branched on whether the read happened. A test cannot assert "this does not compile", so it
  // asserts the runtime shape the type rests on — a faulted read carries `read: false` and NO
  // value, so there is nothing to mistake for an answer.
  it.effect("attempted() reports whether the read happened, and carries no answer when it did not", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const { db } = yield* Database.Service
      yield* store.createAccount({ driverID: "telegram", label: "t", enabled: true, settings: {} })

      const before = yield* MessengerStore.attempted(store.listAccounts())
      expect(before.read).toBe(true)
      expect(before.value).toHaveLength(1)

      yield* db.run("DROP TABLE messenger_account")
      const after = yield* MessengerStore.attempted(store.listAccounts())
      expect(after.read).toBe(false)
      expect(after.value).toBeUndefined()
    }),
  )

  it.effect("removing an account cascades chats, contacts, bindings, and cursor", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const account = yield* store.createAccount({ driverID: "telegram", label: "t", enabled: true, settings: {} })
      yield* store.seenChat({ accountID: account.id, chatID: "1", kind: "dm", title: "x", at: 1 })
      yield* store.upsertContact({
        accountID: account.id,
        senderID: "u",
        name: "x",
        trust: "client",
        pairedAt: undefined,
      })
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
