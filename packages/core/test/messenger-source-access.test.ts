import { describe, expect, test } from "bun:test"
import type { Cause } from "effect"
import { Effect, Layer, Queue, Stream } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Offline } from "@novaclaw/core/offline"
import { SessionV2 } from "@novaclaw/core/session"
import { MessengerDriver } from "@novaclaw/core/messenger/driver"
import { MessengerDrivers } from "@novaclaw/core/messenger/drivers"
import { MessengerGateway } from "@novaclaw/core/messenger/gateway"
import { MessengerPace } from "@novaclaw/core/messenger/pace"
import { MessengerStore } from "@novaclaw/core/messenger/store"
import { testEffect } from "./lib/effect"

/**
 * ⭐ **todo.md ruling 7's mechanical check** — *chat privacy is a SOURCE LABEL, not a transport enum.*
 *
 * The ruling replaces a rule that lived only as prose in the `messenger` tool's description ("for
 * research read kind `channel` only"), which is the defect class ruling 1 names: a normative claim
 * about code outside its own file, whose violation compiles green. It also rules out, by name, the
 * three shapes that look like fixes and are not — `broadcast: boolean` (cannot express *no
 * evidence*, the majority case), `guild_id !== undefined` (a company's internal server has it set),
 * and post-hoc filtering of the report (by then the private text is already in the model's context).
 *
 * So the invariants this file pins are the ones whose violation would be silent:
 *
 *   1. **"No evidence" is representable, and it is the DEFAULT** — not a fallback nobody chose.
 *   2. **A driver PROPOSAL can never become the user's DECLARATION.** Evidence may lock a door; it
 *      may never open one. `access === "public"` implies `by === "user"`, over every input.
 *   3. **A driver sighting cannot overwrite a declaration** — the store-level version of (2), and
 *      the one that would rot quietly, because it fails only after a reconnect on a real account.
 *   4. **The gate is at the gateway READ SEAM**, before the driver is asked for a single message.
 *
 * Every one of them is negative-controlled in place: the control breaks the rule in the test's own
 * code and asserts the check goes red, so a check that has stopped biting cannot pass as one that
 * bites. (There is no way to negative-control a *source* edit from inside a test, so each control
 * re-implements the wrong version beside the right one and shows the assertion separating them.)
 */

// ── the label law, pure ────────────────────────────────────────────────────────────────────────

const ACCESS = Messenger.Source.Access.literals
type Access = Messenger.SourceAccess

describe("Messenger.Source — the label law", () => {
  test("the vocabulary is the tri-state the ruling requires, no more and no less", () => {
    // A boolean is what ruling 7 rules out, so the count is load-bearing: two states cannot hold
    // "no evidence", and a fourth would have to earn a behaviour of its own.
    expect([...ACCESS].sort()).toEqual(["private", "public", "unknown"])
  })

  test("no evidence is representable, and it is the DEFAULT", () => {
    // Three ways to say "nobody has told us anything", all of which must land on the same state.
    expect(Messenger.Source.resolve(undefined)).toEqual({ access: "unknown", by: "default" })
    expect(Messenger.Source.resolve(Messenger.Source.UNLABELLED)).toEqual({ access: "unknown", by: "default" })
    expect(Messenger.Source.resolve({ proposed: "unknown" })).toEqual({ access: "unknown", by: "default" })
    // `by: "default"` is the part that matters — it says nobody chose, which is different from a
    // user who chose `unknown` (below). A design that collapsed the two would lose the ability to
    // ASK, and asking is the whole repair path.
    expect(Messenger.Source.resolve({ proposed: "unknown", declared: "unknown" })).toEqual({
      access: "unknown",
      by: "user",
    })
  })

  test("a driver PROPOSAL can never become the user's declaration", () => {
    // Exhaustive over the vocabulary, so a new state cannot be added without answering this.
    for (const proposed of ACCESS) {
      const decision = Messenger.Source.resolve({ proposed })
      expect(decision.by, `a bare ${proposed} proposal must not read as the user's word`).not.toBe("user")
      expect(decision.access, `a bare ${proposed} proposal must never resolve public`).not.toBe("public")
      expect(Messenger.Source.citable({ proposed })).toBe(false)
    }

    // ⛔ NEGATIVE CONTROL — the obvious wrong implementation, the one a reasonable person writes
    //    first: effective = declared ?? proposed. It passes every OTHER test in this file. It fails
    //    exactly here, which is what makes this assertion the guard rather than decoration.
    const naive = (label: { proposed: Access; declared?: Access }) => label.declared ?? label.proposed
    expect(naive({ proposed: "public" })).toBe("public")
    expect(Messenger.Source.resolve({ proposed: "public" }).access).toBe("unknown")
  })

  test("public is reachable ONLY through the user's declaration", () => {
    // The full cross product — every proposal against every declaration and against none.
    for (const proposed of ACCESS)
      for (const declared of [...ACCESS, undefined]) {
        const label = { proposed, ...(declared === undefined ? {} : { declared }) }
        const decision = Messenger.Source.resolve(label)
        if (decision.access === "public")
          expect(decision.by, `${proposed}/${String(declared)} resolved public without the user`).toBe("user")
        expect(Messenger.Source.citable(label)).toBe(decision.access === "public")
      }
  })

  test("the user's declaration overrides the driver in BOTH directions", () => {
    // Overriding downward is the easy half. Overriding UPWARD is the one that makes the label
    // user-owned rather than driver-owned: the studio's `#news` channel Discord proposed nothing
    // about becomes a citable source because a person said so.
    expect(Messenger.Source.resolve({ proposed: "private", declared: "public" })).toEqual({
      access: "public",
      by: "user",
    })
    expect(Messenger.Source.resolve({ proposed: "public", declared: "private" })).toEqual({
      access: "private",
      by: "user",
    })
    expect(Messenger.Source.resolve({ proposed: "unknown", declared: "public" })).toEqual({
      access: "public",
      by: "user",
    })
  })

  test("a driver proposal may RESTRICT, because restricting is free", () => {
    const decision = Messenger.Source.resolve({ proposed: "private" })
    expect(decision).toEqual({ access: "private", by: "driver" })
    // …and `by` says whose verdict it is, so the UI can offer "this is actually public" without
    // pretending the user already answered.
    expect(decision.by).not.toBe("user")
  })
})

// ── the store: a sighting cannot touch a declaration ───────────────────────────────────────────

const itStore = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, MessengerStore.node, FSUtil.node])))

describe("MessengerStore — the declaration is the user's alone", () => {
  itStore.effect("a chat is born unlabelled: no proposal, nobody asked", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const account = yield* store.createAccount({ driverID: "fake", label: "t", enabled: true, settings: {} })
      // A driver with nothing to say — the majority case, and the one a boolean cannot express.
      yield* store.seenChat({ accountID: account.id, chatID: "c1", kind: "channel", title: "#news", at: 10 })
      const [chat] = yield* store.listChats(account.id)
      expect(chat?.access).toEqual({ proposed: "unknown" })
      expect(Messenger.Source.resolve(chat?.access)).toEqual({ access: "unknown", by: "default" })
    }),
  )

  itStore.effect("a driver sighting refreshes the PROPOSAL and never overwrites the DECLARATION", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const account = yield* store.createAccount({ driverID: "fake", label: "t", enabled: true, settings: {} })
      yield* store.seenChat({
        accountID: account.id,
        chatID: "c1",
        kind: "channel",
        title: "#news",
        at: 10,
        proposedAccess: "unknown",
      })
      expect(yield* store.declareChatAccess({ accountID: account.id, chatID: "c1", access: "public" })).toBe(true)

      // Now the account reconnects and the driver re-reports the chat — with a DIFFERENT proposal,
      // the shape that would quietly undo the user's word if `seenChat` wrote `declared_access`.
      yield* store.seenChat({
        accountID: account.id,
        chatID: "c1",
        kind: "channel",
        title: "#news (renamed)",
        at: 20,
        proposedAccess: "private",
      })
      const after = yield* store.getChat(account.id, "c1")
      expect(after?.title).toBe("#news (renamed)") // the sighting DID refresh what it owns…
      expect(after?.access.proposed).toBe("private") // …including the proposal…
      expect(after?.access.declared).toBe("public") // …and not one thing more.
      expect(Messenger.Source.resolve(after?.access)).toEqual({ access: "public", by: "user" })

      // ⛔ NEGATIVE CONTROL: had the upsert included `declared_access` in its SET (the one-word
      //    change that makes this test's subject disappear), the resolved verdict would follow the
      //    driver instead. Shown here as the value that WOULD have been stored, beside the one that
      //    was — so this assertion pair goes red the moment the columns are merged.
      const ifSeenChatWroteBoth = { proposed: "private" as Access, declared: "private" as Access }
      expect(Messenger.Source.resolve(ifSeenChatWroteBoth).access).toBe("private")
      expect(Messenger.Source.resolve(after?.access).access).toBe("public")
    }),
  )

  itStore.effect("a declaration about a chat nobody has seen is refused, not invented", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const account = yield* store.createAccount({ driverID: "fake", label: "t", enabled: true, settings: {} })
      expect(yield* store.declareChatAccess({ accountID: account.id, chatID: "ghost", access: "public" })).toBe(false)
      // …and no ghost row with a privacy verdict and nothing else was created.
      expect(yield* store.listChats(account.id)).toEqual([])
      expect(yield* store.getChat(account.id, "ghost")).toBeUndefined()
    }),
  )

  itStore.effect("a declaration can be cleared back to `nobody has chosen`", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const account = yield* store.createAccount({ driverID: "fake", label: "t", enabled: true, settings: {} })
      yield* store.seenChat({ accountID: account.id, chatID: "c1", kind: "channel", title: "#news", at: 10 })
      yield* store.declareChatAccess({ accountID: account.id, chatID: "c1", access: "public" })
      yield* store.declareChatAccess({ accountID: account.id, chatID: "c1", access: undefined })
      const chat = yield* store.getChat(account.id, "c1")
      // Cleared is the DEFAULT state again, not a declared "unknown" — a user who un-marks a chat
      // has withdrawn their word, and the product must go back to asking rather than to asserting.
      expect(chat?.access.declared).toBeUndefined()
      expect(Messenger.Source.resolve(chat?.access)).toEqual({ access: "unknown", by: "default" })
    }),
  )

  itStore.effect("getChat FAILS TYPED when the table is gone — it never answers `no such chat`", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const { db } = yield* Database.Service
      const account = yield* store.createAccount({ driverID: "fake", label: "t", enabled: true, settings: {} })
      yield* store.seenChat({ accountID: account.id, chatID: "c1", kind: "channel", title: "#news", at: 10 })
      expect(yield* store.getChat(account.id, "c1")).toBeDefined()

      yield* db.run("DROP TABLE messenger_chat")
      const failure = yield* store.getChat(account.id, "c1").pipe(Effect.flip)
      expect(failure._tag).toBe("MessengerStore.Unavailable")
      // The distinction the ruling-7 gate depends on: `undefined` would have meant "not a chat we
      // know", which the gate would have explained to the model as a fact about the user's account.
      expect(yield* MessengerStore.attempted(store.getChat(account.id, "c1"))).toEqual({
        read: false,
        value: undefined,
      })
    }),
  )
})

// ── the gateway read seam ──────────────────────────────────────────────────────────────────────

const CAPS: Messenger.Capabilities = {
  listChats: "full",
  files: { up: false, down: false },
  edits: false,
  typing: false,
  threads: false,
  moderation: { delete: false, ban: false, kick: false, mute: false, pin: false },
  format: "plain",
  maxChars: 1000,
}

const HISTORY: readonly MessengerDriver.HistoryEntry[] = [
  { messageID: "m1", senderID: "u1", senderName: "Someone", outgoing: false, text: "the secret", at: 1000 },
]

const makeFakeDriver = () => {
  const state = {
    /** Every chat the driver would list, and what it PROPOSES about each. */
    chats: [] as MessengerDriver.ChatSnapshot[],
    /** Non-zero means the driver was actually asked for messages — the seam must keep this at 0. */
    historyCalls: 0,
    queue: undefined as Queue.Queue<MessengerDriver.InboundEvent, Cause.Done> | undefined,
  }
  const driver: MessengerDriver.Driver = {
    id: "fake",
    meta: { id: "fake", name: "Fake", icon: "chat", auth: "none", settings: [], capabilities: CAPS },
    capabilities: () => CAPS,
    connect: () =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<MessengerDriver.InboundEvent, Cause.Done>()
        state.queue = queue
        return {
          inbound: Stream.fromQueue(queue),
          send: () => Effect.succeed({ messageID: "m" }),
          listChats: () => Effect.succeed(state.chats),
          history: () =>
            Effect.sync(() => {
              state.historyCalls += 1
              return HISTORY
            }),
        } satisfies MessengerDriver.Connection
      }),
  }
  return { driver, state }
}

const fake = makeFakeDriver()

const itGateway = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, FSUtil.node, MessengerStore.node, MessengerGateway.node]),
    [
      [
        MessengerDrivers.node,
        Layer.succeed(MessengerDrivers.Service, MessengerDrivers.Service.of(MessengerDrivers.make([fake.driver]))),
      ],
      [
        Offline.node,
        Layer.mock(Offline.Service)({
          policy: { enabled: false, allowedHosts: new Set<string>() },
          check: () => ({ allowed: true }) as const,
          egressEnv: () => undefined,
          manifest: () => ({ enabled: false, active: 0, total: 9, layers: [] }),
        }),
      ],
      [SessionV2.node, Layer.mock(SessionV2.Service, {} as never)],
      [MessengerPace.node, MessengerPace.layerWith({ sleep: () => Effect.void })],
    ],
  ),
)

/** Boot one connected account whose driver lists `chats`, and wait for the seen-cache to hold them. */
const online = (chats: MessengerDriver.ChatSnapshot[]) =>
  Effect.gen(function* () {
    const store = yield* MessengerStore.Service
    const gateway = yield* MessengerGateway.Service
    fake.state.chats = chats
    fake.state.historyCalls = 0
    const account = yield* store.createAccount({ driverID: "fake", label: "t", enabled: true, settings: {} })
    yield* gateway.reload()
    // `chats()` is also what SEEDS the cache from a live list, so this call is the setup and the
    // subject at once — everything below reads the labels it just wrote.
    for (let round = 0; round < 200; round++) {
      const outcome = yield* gateway.chats(account.id)
      if (outcome.ok && outcome.chats.length === chats.length) return { store, gateway, account, listed: outcome.chats }
      yield* Effect.sleep("25 millis")
    }
    return yield* Effect.die("timeout waiting for the account to list its chats")
  })

const NEWS: MessengerDriver.ChatSnapshot = {
  chatID: "c-news",
  kind: "channel",
  title: "#news",
  proposedAccess: "unknown",
}
const CLAIMED: MessengerDriver.ChatSnapshot = {
  chatID: "c-sub",
  kind: "channel",
  title: "r/x",
  proposedAccess: "public",
}
const DM: MessengerDriver.ChatSnapshot = { chatID: "c-dm", kind: "dm", title: "Nancy", proposedAccess: "private" }

describe("MessengerGateway — ruling 7 at the read seam", () => {
  itGateway.live("chats() carries the label: the driver's proposal AND the user's declaration", () =>
    Effect.gen(function* () {
      const { store, gateway, account } = yield* online([NEWS, CLAIMED, DM])
      yield* store.declareChatAccess({ accountID: account.id, chatID: "c-news", access: "public" })

      const outcome = yield* gateway.chats(account.id)
      if (!outcome.ok) throw new Error(outcome.reason)
      const byID = new Map(outcome.chats.map((chat) => [chat.chatID, chat]))
      // ⚠️ The declaration survives a LIVE list. The live snapshot knows only the proposal, so a
      // seam that returned it verbatim would drop every declaration the user ever made and let the
      // driver's guess win by being fresher — the inference the ruling forbids, wearing a cache bug.
      expect(byID.get("c-news")?.access).toEqual({ proposed: "unknown", declared: "public" })
      expect(byID.get("c-sub")?.access).toEqual({ proposed: "public" })
      expect(byID.get("c-dm")?.access).toEqual({ proposed: "private" })

      // It LABELS, it does not filter: the operator's own DM is still listed, because reading your
      // own messages is the product. What the label decides is what may leave this conversation.
      expect(outcome.chats.map((chat) => chat.chatID).sort()).toEqual(["c-dm", "c-news", "c-sub"])
    }),
  )

  itGateway.live("an unlabelled chat is refused for research, and the refusal names the one step that fixes it", () =>
    Effect.gen(function* () {
      const { gateway, account } = yield* online([NEWS])
      const outcome = yield* gateway.history({
        accountID: account.id,
        chatID: "c-news",
        limit: 10,
        purpose: "research",
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.reason).toContain("Nobody has said whether")
        expect(outcome.reason).toContain("Settings → Messengers")
      }
      // ⚠️ THE point of "at the read seam". The driver was never asked, so the private text never
      // entered the model's context — which is what ruling 7 means by ruling out post-hoc filtering
      // of the report. A filter downstream would show this counter at 1 and still call itself a fix.
      expect(fake.state.historyCalls).toBe(0)
    }),
  )

  itGateway.live("a driver's `public` proposal does NOT unlock research", () =>
    Effect.gen(function* () {
      const { gateway, account } = yield* online([CLAIMED])
      const outcome = yield* gateway.history({ accountID: account.id, chatID: "c-sub", limit: 10, purpose: "research" })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        // The refusal SAYS the driver proposed it, so the user can confirm in one click instead of
        // wondering why a channel that is obviously public is being withheld.
        expect(outcome.reason).toContain("the driver thinks it is public")
        expect(outcome.reason).toContain("not the user's word")
      }
      expect(fake.state.historyCalls).toBe(0)
    }),
  )

  itGateway.live("private correspondence is refused for research even though the operator may read it", () =>
    Effect.gen(function* () {
      const { gateway, account } = yield* online([DM])
      const research = yield* gateway.history({ accountID: account.id, chatID: "c-dm", limit: 10, purpose: "research" })
      expect(research.ok).toBe(false)
      if (!research.ok) expect(research.reason).toContain("private correspondence")
      expect(fake.state.historyCalls).toBe(0)

      // …and the SAME chat, read as correspondence, still works. This is the regression that would
      // matter most to a real user: the shipped product is the operator reading their own messages.
      const own = yield* gateway.history({ accountID: account.id, chatID: "c-dm", limit: 10 })
      expect(own.ok).toBe(true)
      if (own.ok) expect(own.messages.map((message) => message.text)).toEqual(["the secret"])
      expect(fake.state.historyCalls).toBe(1)
    }),
  )

  itGateway.live("a user who declared `unknown` is quoted as saying that, not as saying `private`", () =>
    Effect.gen(function* () {
      const { store, gateway, account } = yield* online([CLAIMED])
      // The user LOOKED at the driver's `public` proposal and answered "I don't know". That is a
      // third state — refused like the others, but described as what they actually said.
      yield* store.declareChatAccess({ accountID: account.id, chatID: "c-sub", access: "unknown" })
      const outcome = yield* gateway.history({ accountID: account.id, chatID: "c-sub", limit: 10, purpose: "research" })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.reason).toContain("marked as unclear")
        // Ruling 2: describing their answer as "private correspondence" would put words in the
        // user's mouth, and describing it as "nobody has said" would erase that they answered.
        expect(outcome.reason).not.toContain("private correspondence")
        expect(outcome.reason).not.toContain("Nobody has said")
      }
      expect(fake.state.historyCalls).toBe(0)
    }),
  )

  itGateway.live("the user's declaration — and only that — unlocks research", () =>
    Effect.gen(function* () {
      const { store, gateway, account } = yield* online([NEWS])
      const before = yield* gateway.history({ accountID: account.id, chatID: "c-news", limit: 10, purpose: "research" })
      expect(before.ok).toBe(false)

      yield* store.declareChatAccess({ accountID: account.id, chatID: "c-news", access: "public" })
      const after = yield* gateway.history({ accountID: account.id, chatID: "c-news", limit: 10, purpose: "research" })
      expect(after.ok).toBe(true)
      if (after.ok) expect(after.messages.map((message) => message.text)).toEqual(["the secret"])
      expect(fake.state.historyCalls).toBe(1)

      // ⛔ NEGATIVE CONTROL for the gate itself: withdraw the declaration and the same call must go
      //    back to refusing. A gate that only ever opens is indistinguishable from no gate at all.
      yield* store.declareChatAccess({ accountID: account.id, chatID: "c-news", access: undefined })
      const withdrawn = yield* gateway.history({
        accountID: account.id,
        chatID: "c-news",
        limit: 10,
        purpose: "research",
      })
      expect(withdrawn.ok).toBe(false)
      expect(fake.state.historyCalls).toBe(1)
    }),
  )

  itGateway.live("an unreadable chat table refuses research under its own name", () =>
    Effect.gen(function* () {
      const { store, gateway, account } = yield* online([NEWS])
      yield* store.declareChatAccess({ accountID: account.id, chatID: "c-news", access: "public" })
      const { db } = yield* Database.Service
      yield* db.run("DROP TABLE messenger_chat")

      const outcome = yield* gateway.history({
        accountID: account.id,
        chatID: "c-news",
        limit: 10,
        purpose: "research",
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        // Ruling 2 — a fault is never described falsely. The honest sentence is "I could not look",
        // not "that chat is private", which is a statement about the user's account made from a
        // read that never happened.
        expect(outcome.reason).toContain("couldn't read this instance's chat table")
        expect(outcome.reason).not.toContain("private correspondence")
      }
      expect(fake.state.historyCalls).toBe(0)
    }),
  )
})
