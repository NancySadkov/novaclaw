import { describe, expect } from "bun:test"
import nodePath from "node:path"
import type { Cause } from "effect"
import { Duration, Effect, Layer, Queue, Stream } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Global } from "@novaclaw/core/global"
import { Offline } from "@novaclaw/core/offline"
import { SessionV2 } from "@novaclaw/core/session"
import { MessengerDriver } from "@novaclaw/core/messenger/driver"
import { MessengerDrivers } from "@novaclaw/core/messenger/drivers"
import { MessengerGateway } from "@novaclaw/core/messenger/gateway"
import { MessengerPace } from "@novaclaw/core/messenger/pace"
import { MessengerStore } from "@novaclaw/core/messenger/store"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

/**
 * **Three promises the messenger gateway makes about a message it has taken responsibility for.**
 *
 *  1. **It never records a delivery it has not made.** Inbound is claimed durably before it is
 *     attempted and marked "routed" once a session has it — and an audience-trust (moderated) chat
 *     does neither in one step: it COALESCES, holding up to twenty messages in memory until a batch
 *     fills or thirty seconds pass. The mark used to be written the moment the delivery function
 *     returned, which for a buffered message meant "routed" was recorded for a message sitting in
 *     RAM. A restart then lost as many as nineteen moderation messages **with the ledger claiming
 *     every one of them had been handled**, so nothing would ever re-deliver them: the record of a
 *     success outliving the thing it recorded (`notes/reports/decisions-v0.2.0.md` ruling 2).
 *  2. **Every outbound path types at the account's speed** (AGENTS.md design principle 9(a): human-
 *     paced output, globally, one hand). A send that skips the per-account pace is a burst from a
 *     real person's account, which is what gets accounts flagged.
 *  3. **What it hands back holds everything it found.** A message carries a LIST of attachments.
 *
 * **A/B controls (each invariant separately reversible).**
 *  · Put the durable mark back on the caller — `markInboundRouted` straight after `deliverInbound`
 *    in `routeInbound` — and the buffered messages come back `"delivered"` from the second instance
 *    instead of `"recovering"`. (Under the current code that edit does not even compile: the mark
 *    travels with the message and `deliverInbound` must answer what it did with it.)
 *  · Drop `connectionPace.get(connection)` from the gateway's `paceOperation` (or route `sendFile`
 *    around it, as it once was) and the file's pacing falls back to the default typing speed while
 *    the text send keeps the account's.
 *  · Take the first attachment only and the three-attachment leg comes back with one.
 */

const CAPS: Messenger.Capabilities = {
  listChats: "full",
  files: { up: true, down: true },
  edits: false,
  threads: false,
  moderation: { delete: false, ban: false, kick: false, mute: false, pin: false },
  format: "plain",
  maxChars: 1000,
}

const makeFakeDriver = () => {
  const state = {
    queue: undefined as Queue.Queue<MessengerDriver.InboundEvent, Cause.Done> | undefined,
    sent: [] as { chatID: string; text: string | undefined; fileName?: string }[],
    /** Downloadable bytes by `FileRef` id; a ref with no entry fails the way a real one does. */
    files: {} as Record<string, Uint8Array>,
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
          send: (chatID, message) =>
            Effect.sync(() => {
              state.sent.push({
                chatID,
                text: message.text,
                ...(message.file === undefined ? {} : { fileName: message.file.name }),
              })
              return { messageID: "m" + state.sent.length }
            }),
          downloadFile: (ref) =>
            Effect.suspend(() => {
              const data = state.files[ref.id]
              return data === undefined
                ? Effect.fail(new MessengerDriver.FileError({ reason: "no such file" }))
                : Effect.succeed(data)
            }),
        } satisfies MessengerDriver.Connection
      }),
  }
  return { driver, state }
}

const fake = makeFakeDriver()

/** Every turn the gateway injected, in order — the only evidence a message reached a session. */
const prompts: { sessionID: string; text: string }[] = []
const sessionMock = Layer.mock(SessionV2.Service, {
  prompt: (input: { sessionID: string; prompt: { text: string } }) =>
    Effect.sync(() => {
      prompts.push({ sessionID: input.sessionID, text: input.prompt.text })
      return undefined as never
    }),
  list: () => Effect.succeed([] as never),
  get: () => Effect.fail({ _tag: "Session.NotFoundError" } as never),
} as never)

/**
 * Every pacing sleep the gateway asked for, in milliseconds. The pacer is REAL (one global permit,
 * the real `typingDelayMs`); only the waiting is swapped out, so the suite stays instant while the
 * numbers it records are the ones a live account would actually type at.
 */
const paceDelays: number[] = []

const REPLACEMENTS = [
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
  [SessionV2.node, sessionMock],
  [
    MessengerPace.node,
    MessengerPace.layerWith({
      sleep: (ms: number) =>
        Effect.sync(() => {
          paceDelays.push(ms)
        }),
    }),
  ],
] satisfies LayerNode.Replacements

const graph = LayerNode.group([
  Database.node,
  EventV2.node,
  FSUtil.node,
  Global.node,
  MessengerStore.node,
  MessengerGateway.node,
])

const it = testEffect(AppNodeBuilder.build(graph, REPLACEMENTS))

/**
 * The same graph over a database FILE — a whole second instance of the product, for the one test
 * that has to outlive the first.
 *
 * ⚠️ `Layer.fresh` is load-bearing. Effect memoizes a layer by its inner reference and
 * `Effect.provide` inherits the fiber's memo map, so without it the "second instance" is the object
 * the suite already built: one heap wearing two names, and a durability assertion that can only
 * pass. (The same guard, and the same reason, as the cold-start budget's restart test.)
 */
const overFile = (file: string) =>
  Layer.fresh(AppNodeBuilder.build(graph, [...REPLACEMENTS, [Database.node, Database.layerFromPath(file)]]))

let seq = 0
const message = (
  chatID: string,
  opts?: { text?: string; title?: string; attachments?: MessengerDriver.FileRef[] },
) => ({
  kind: "message" as const,
  chat: { chatID, kind: "channel" as const, title: opts?.title ?? "Chat " + chatID },
  messageID: "msg-" + ++seq,
  sender: { id: "u1", name: "Someone", isSelf: false },
  text: opts?.text ?? "hello",
  ...(opts?.attachments === undefined ? {} : { attachments: opts.attachments }),
  at: Date.now(),
})

const eventually = <A, E>(effect: Effect.Effect<A, E>, predicate: (value: A) => boolean, label: string, rounds = 200) =>
  Effect.gen(function* () {
    for (let round = 0; round < rounds; round++) {
      const value = yield* effect
      if (predicate(value)) return value
      yield* Effect.sleep(Duration.millis(25))
    }
    return yield* Effect.die(`timeout waiting for ${label}`)
  })

/** Bring the one fake account online and hand back its live inbound queue. */
const online = (label: string, settings: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const store = yield* MessengerStore.Service
    const gateway = yield* MessengerGateway.Service
    const account = yield* store.createAccount({ driverID: "fake", label, enabled: true, settings })
    yield* gateway.reload()
    yield* eventually(gateway.status(), (map) => map.get(account.id)?.state === "connected", `connected (${label})`)
    const queue = fake.state.queue
    if (queue === undefined) throw new Error("driver queue missing")
    return { store, gateway, account, queue }
  })

describe("messenger gateway — what it may claim to have done", () => {
  /**
   * ⏱ LIVE, deliberately. The interesting half of this test is a NEGATIVE — three messages the
   * gateway must NOT have handed to a session yet — and a negative assertion's whole strength is the
   * real elapsed time it gives the pipeline to misbehave in. It waits on no production timer: the
   * thirty-second coalescing window is precisely what it must NOT reach.
   */
  it.live("🔴 a moderation message still in the batch buffer is not recorded as delivered", () =>
    Effect.gen(function* () {
      // ⚠️ The shared fixture, not `os.tmpdir() + process.pid`: a killed run leaves a PID-named file
      // behind, and PID reuse then hands it to a LATER run as live state. `tmpdir()` is
      // mkdtemp-unique and its root is reaped by the next run whatever killed this one.
      // `tmpdir-namespace.test.ts` fails the gate on the other shape. Acquired through the scope
      // rather than `await using`, because this body is an `Effect.gen` and has no `await`.
      const temp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (handle) => Effect.promise(() => handle[Symbol.asyncDispose]()),
      )
      const file = nodePath.join(temp.path, "audience-restart.db")
      const buffered: string[] = []
      let injected = ""
      let accountID = "" as Messenger.AccountID

      // ── Instance #1: an audience (moderated) chat and an ordinary bound one, side by side.
      yield* Effect.gen(function* () {
        const { store, gateway, account, queue } = yield* online("audience-restart")
        accountID = account.id
        yield* store.createBinding({ accountID: account.id, chatID: "#news", sessionID: "ses_mod", trust: "audience" })
        yield* store.createBinding({ accountID: account.id, chatID: "#ops", sessionID: "ses_ops", trust: "operator" })
        const promptsBefore = prompts.length

        // Three hecklers — well under the batch size of twenty, so nothing flushes.
        for (let index = 1; index <= 3; index++) {
          const event = message("#news", { text: `heckle ${index}`, title: `news ${index}` })
          buffered.push(event.messageID)
          yield* Queue.offer(queue, event)
        }
        // The THIRD message's own sighting is the signal that all three have been consumed —
        // `seenChat` runs before the buffer does, and it upserts the title.
        yield* eventually(
          store.getChat(account.id, "#news").pipe(Effect.orElseSucceed(() => undefined)),
          (chat) => chat?.title === "news 3",
          "all three seen",
        )
        // …and not one of them has reached a session. This is the state a crash catches.
        expect(prompts.slice(promptsBefore)).toEqual([])

        // The CONTROL, in the same instance and over the same ledger: an ordinary bound chat, whose
        // message really is handed to a session. Without it this test passes on a gateway that had
        // simply stopped marking anything at all.
        const delivered = message("#ops", { text: "deploy is green" })
        injected = delivered.messageID
        yield* Queue.offer(queue, delivered)
        yield* eventually(
          Effect.sync(() => prompts.slice(promptsBefore)),
          (seen) => seen.some((entry) => entry.sessionID === "ses_ops"),
          "bound chat injected",
        )
      }).pipe(Effect.scoped, Effect.provide(overFile(file)))

      // ── The restart. A brand-new instance over the same bytes reads the ledger and nothing else;
      // the buffer that held those three messages died with the process that owned it.
      yield* Effect.gen(function* () {
        const store = yield* MessengerStore.Service
        for (const messageID of buffered) {
          // `recovering` = "claimed by a run that died before delivering; route it". `delivered`
          // would retire the row for good — the message would be lost AND recorded as handled,
          // which is the whole defect. `fresh` would mean it was never consumed at all.
          expect(yield* store.claimInbound({ accountID, chatID: "#news", messageID })).toBe("recovering")
        }
        expect(yield* store.claimInbound({ accountID, chatID: "#ops", messageID: injected })).toBe("delivered")
      }).pipe(Effect.scoped, Effect.provide(overFile(file)))
    }).pipe(Effect.scoped),
  )

  it.live("a batch that FLUSHES marks every message in it delivered — and only then", () =>
    Effect.gen(function* () {
      const { store, gateway, account, queue } = yield* online("audience-flush")
      yield* store.createBinding({ accountID: account.id, chatID: "#flush", sessionID: "ses_mod", trust: "audience" })
      const promptsBefore = prompts.length
      const ids: string[] = []
      // Exactly the batch size: the twentieth trips the size cap and the whole batch goes as ONE turn.
      for (let index = 1; index <= 20; index++) {
        const event = message("#flush", { text: `heckle ${index}`, title: `flush ${index}` })
        ids.push(event.messageID)
        yield* Queue.offer(queue, event)
      }
      yield* eventually(
        Effect.sync(() => prompts.slice(promptsBefore)),
        (seen) => seen.some((entry) => entry.sessionID === "ses_mod"),
        "batch flushed as one turn",
      )
      // Every message in the flushed batch becomes durably delivered — the mark rides the flush, so
      // it is written for all twenty and not only for the one that tripped the cap. Polled rather
      // than read once: the prompt appearing and the twenty marks landing are separate steps on the
      // gateway's own fiber, and reading between them would be a race in the TEST, not a defect.
      const claims = yield* eventually(
        Effect.forEach(ids, (messageID) => store.claimInbound({ accountID: account.id, chatID: "#flush", messageID })),
        (seen) => seen.every((claim) => claim === "delivered"),
        "every message in the flushed batch marked delivered",
      )
      expect(claims).toHaveLength(20)
      yield* store.removeAccount(account.id)
      yield* gateway.reload()
    }),
  )

  it.live("🔴 sendFile types at the ACCOUNT's speed, exactly as a text send does (#9(a))", () =>
    Effect.gen(function* () {
      // A deliberately slow typist, so the account's own speed and the built-in default cannot be
      // confused for one another: the same string pays several times more here than at the default.
      const { store, gateway, account, queue } = yield* online("pace", { [MessengerPace.PACE_SETTING_KEY]: "3" })
      // Neither op may cold-start, so the chat has to have written to us first.
      yield* Queue.offer(queue, message("pc1", { text: "can you send me the deck?" }))
      yield* eventually(store.hasInbound(account.id, "pc1"), (seen) => seen === true, "inbound claimed")

      // `sendFile` paces on `"<file name> <caption>"`. Send exactly that string as TEXT, so the two
      // measurements differ in nothing but which gateway path produced them.
      const PACED = "report-v2.pdf "
      const textAt = paceDelays.length
      expect((yield* gateway.send({ accountID: account.id, chatID: "pc1", text: PACED })).kind).toBe("sent")
      const textDelay = paceDelays[textAt]

      const fileAt = paceDelays.length
      const sent = yield* gateway.sendFile({
        accountID: account.id,
        chatID: "pc1",
        file: { name: "report-v2.pdf", mime: "application/pdf", data: new Uint8Array([1, 2, 3]) },
      })
      expect(sent.kind).toBe("sent")
      const fileDelay = paceDelays[fileAt]

      // The measurement, not a flag: the file paid the same typing time the identical text did.
      expect(fileDelay).toBe(textDelay!)
      // …and that time is the ACCOUNT's, not the built-in default. At the default speed this string
      // costs under a second; the bound is far above it and far below the pacer's ceiling, so it
      // cannot be satisfied by a clamp at either end.
      expect(textDelay).toBeGreaterThan(3_000)
      expect(textDelay).toBeLessThan(6_000)
      yield* store.removeAccount(account.id)
      yield* gateway.reload()
    }),
  )

  it.live("🔴 a message with three attachments downloads three; a message with one downloads one", () =>
    Effect.gen(function* () {
      const { store, gateway, account, queue } = yield* online("attachments")
      fake.state.files["a1"] = new TextEncoder().encode("first")
      fake.state.files["a2"] = new TextEncoder().encode("second")
      fake.state.files["a3"] = new TextEncoder().encode("third")

      const many = message("#gallery", {
        text: "three shots",
        attachments: [
          { id: "a1", name: "photo.jpg", mime: "image/jpeg" },
          { id: "a2", name: "photo.jpg", mime: "image/jpeg" },
          { id: "a3", name: "notes.txt", mime: "text/plain" },
        ],
      })
      yield* Queue.offer(queue, many)
      yield* eventually(store.hasInbound(account.id, "#gallery"), (seen) => seen === true, "gallery seen")

      const all = yield* gateway.attachment({
        accountID: account.id,
        chatID: "#gallery",
        messageID: many.messageID,
      })
      expect(all.ok).toBe(true)
      if (all.ok) {
        expect(all.files).toHaveLength(3)
        expect(all.files.map((file) => new TextDecoder().decode(file.data))).toEqual(["first", "second", "third"])
        // Two attachments arrived under one name. Handing back both under it would have one
        // overwrite the other on disk — the same file lost by a different route.
        expect(new Set(all.files.map((file) => file.name)).size).toBe(3)
        expect(all.failed).toEqual([])
      }

      // The CONTROL: one attachment still yields exactly one, unchanged.
      const one = message("#gallery", { text: "just the one", attachments: [{ id: "a3", name: "notes.txt" }] })
      yield* Queue.offer(queue, one)
      const single = yield* eventually(
        gateway.attachment({ accountID: account.id, chatID: "#gallery", messageID: one.messageID }),
        (outcome) => outcome.ok,
        "single attachment indexed",
      )
      expect(single.ok).toBe(true)
      if (single.ok) {
        expect(single.files).toHaveLength(1)
        expect(single.files[0]!.name).toBe("notes.txt")
        expect(new TextDecoder().decode(single.files[0]!.data)).toBe("third")
      }
      yield* store.removeAccount(account.id)
      yield* gateway.reload()
    }),
  )
})
