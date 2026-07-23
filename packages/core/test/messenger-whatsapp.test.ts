import { describe, expect } from "bun:test"
import { Duration, Effect, Stream } from "effect"
import type { Messenger } from "@novaclaw/schema/messenger"
import { WhatsAppBaileysDriver } from "@novaclaw/core/messenger/driver/whatsapp-baileys"
import type { WAClient, WALink, WAMessage } from "@novaclaw/core/messenger/driver/whatsapp-baileys"
import type { ChatSnapshot, ConnectContext, OutboundFile } from "@novaclaw/core/messenger/driver"
import { WAClientError } from "@novaclaw/core/messenger/driver/whatsapp-baileys"
import { it } from "./lib/effect"

// The WhatsApp (Baileys) driver POLICY half against a fake WAClient — the out-of-band QR/pairing
// login state machine, the self-echo policy (fromMe / Message-Yourself operator console), inbound
// normalization, chunked send + sent-tracking, and the logged-out → challenge park. The Baileys
// socket factory (the only Baileys import) is the live-gated piece (needs the dep + a real phone).

const account = {
  id: "msa_wa" as never,
  driverID: "whatsapp",
  label: "WhatsApp",
  enabled: true,
  settings: {},
} as never as Messenger.AccountInfo

const makeFakeWA = () => {
  const state = {
    sent: [] as { chatID: string; text?: string; file: boolean }[],
    closed: false,
    exported: 0,
    linkPhone: undefined as string | undefined,
    /** The live link the socket publishes — reassigned to simulate a QR rotation. */
    link: {} as WALink,
    meThrows: undefined as WAClientError | undefined,
  }
  let resolveOpen!: () => void
  let rejectOpen!: (error: Error) => void
  const openPromise = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve
    rejectOpen = reject
  })
  const batches: WAMessage[][] = []
  const client: WAClient = {
    me: async () => {
      if (state.meThrows) throw state.meThrows
      return { id: "me@wa", name: "Me" }
    },
    startLink: async (phone) => {
      state.linkPhone = phone
      state.link = phone ? { pairingCode: "ABCD-1234" } : { qr: "QR-BLOB-DATA" }
      return state.link
    },
    currentLink: () => state.link,
    waitForOpen: () => openPromise,
    exportAuth: async () => {
      state.exported += 1
      return "WA-SESSION-BLOB"
    },
    pull: () => (batches.length > 0 ? Promise.resolve(batches.shift()!) : new Promise<readonly WAMessage[]>(() => {})),
    chats: async () => [
      { chatID: "me@wa", kind: "dm", title: "You" } as ChatSnapshot,
      { chatID: "c1@g.us", kind: "group", title: "Team" } as ChatSnapshot,
    ],
    history: async (_chatID, _limit) => [] as WAMessage[],
    sendText: async (chatID, text) => {
      const messageID = `s${state.sent.length}`
      state.sent.push({ chatID, text, file: false })
      return { messageID }
    },
    sendFile: async (chatID, _file: OutboundFile, caption) => {
      const messageID = `f${state.sent.length}`
      state.sent.push({ chatID, text: caption, file: true })
      return { messageID }
    },
    downloadFile: async () => new Uint8Array([1, 2, 3]),
    close: async () => void (state.closed = true),
  }
  return { client, state, resolveOpen, rejectOpen, enqueue: (messages: WAMessage[]) => batches.push(messages) }
}

const factoryFor = (fake: ReturnType<typeof makeFakeWA>) => async () => fake.client

const ctxFor = (secret: string | undefined): ConnectContext => ({
  account,
  secret,
  cursor: { get: () => Effect.succeed(undefined), set: () => Effect.void },
})

const drainFor = <A>(read: () => A, predicate: (value: A) => boolean, label: string) =>
  Effect.gen(function* () {
    for (let round = 0; round < 200; round++) {
      const value = read()
      if (predicate(value)) return value
      yield* Effect.sleep(Duration.millis(10))
    }
    return yield* Effect.die(`timeout waiting for ${label}`)
  })

// ── pure policy ──────────────────────────────────────────────────────────────────────────────────

describe("WhatsAppBaileys pure policy", () => {
  it.effect("isSelfMessage: incoming≠self; our echo=self; Message-Yourself operator=NOT self; elsewhere-human=self", () =>
    Effect.sync(() => {
      const at = 1
      const msg = (over: Partial<WAMessage>): WAMessage => ({ chatID: "c1", chatKind: "group", chatTitle: "t", messageID: "m", senderID: "s", senderName: "n", outgoing: false, at, ...over })
      // incoming (not fromMe) is never self.
      expect(WhatsAppBaileysDriver.isSelfMessage(msg({ outgoing: false }), "me@wa", false)).toBe(false)
      // our own relay echoed back = self (drop).
      expect(WhatsAppBaileysDriver.isSelfMessage(msg({ outgoing: true, chatID: "c1" }), "me@wa", true)).toBe(true)
      // fromMe in the self-chat we did NOT send = the operator on their phone = REAL input.
      expect(WhatsAppBaileysDriver.isSelfMessage(msg({ outgoing: true, chatID: "me@wa" }), "me@wa", false)).toBe(false)
      // fromMe elsewhere we did not send = the human on their account = not our turn (self).
      expect(WhatsAppBaileysDriver.isSelfMessage(msg({ outgoing: true, chatID: "c1" }), "me@wa", false)).toBe(true)
    }),
  )

  it.effect("foldSelfAddress folds the account's LID onto its phone JID (the console depends on it)", () =>
    Effect.sync(() => {
      const self = { id: "31638898568@s.whatsapp.net", lid: "177914775654512@lid" }
      // Found live: the operator's own "Message Yourself" message arrives LID-addressed. Unfolded,
      // chatID !== me.id → the §0.1.5 console never fires and the message is dropped as an echo.
      expect(WhatsAppBaileysDriver.foldSelfAddress(self.lid, self)).toBe(self.id)
      expect(WhatsAppBaileysDriver.foldSelfAddress(self.id, self)).toBe(self.id)
      // Somebody ELSE's LID is a different person — folding that would merge strangers into self.
      expect(WhatsAppBaileysDriver.foldSelfAddress("999@lid", self)).toBe("999@lid")
      expect(WhatsAppBaileysDriver.foldSelfAddress("c1@g.us", self)).toBe("c1@g.us")
      // An account with no LID (older WhatsApp) folds nothing.
      expect(WhatsAppBaileysDriver.foldSelfAddress("177914775654512@lid", { id: self.id })).toBe("177914775654512@lid")
    }),
  )

  it.effect("linkInstructions describes QR vs pairing-code linking", () =>
    Effect.sync(() => {
      expect(WhatsAppBaileysDriver.linkInstructions({ qr: "QR" })).toContain("Link a device")
      expect(WhatsAppBaileysDriver.linkInstructions({ pairingCode: "ABCD-1234" })).toContain("ABCD-1234")
    }),
  )

  it.effect("a rendered QR instructs the user about the image, not the raw payload", () =>
    Effect.sync(() => {
      const rendered = WhatsAppBaileysDriver.linkInstructions({ qr: "RAW-PAYLOAD", qrImage: "data:image/png;base64,AAA" })
      // The image is the instruction; leaking the unscannable payload into the text would only
      // confuse a lay user — and it must say the code refreshes, so a re-render doesn't read as a fault.
      expect(rendered).not.toContain("RAW-PAYLOAD")
      expect(rendered).toContain("refreshes")
    }),
  )

  it.effect("link instructions steer away from WhatsApp's WRONG QR scanner", () =>
    Effect.sync(() => {
      // The owner's first real link failed here: WhatsApp's most prominent QR button is on the chats
      // screen and scans CONTACT codes, not device links. Naming the right menu isn't enough — by
      // the time they read it they have already found a scanner, so the wrong one must be named too.
      for (const link of [
        { qr: "RAW", qrImage: "data:image/png;base64,AAA" },
        { qr: "RAW" }, // the unrendered fallback gets the same steering
      ])
        for (const needle of ["Linked devices", "Link a device", "chats screen", "adds a contact"])
          expect(WhatsAppBaileysDriver.linkInstructions(link)).toContain(needle)
      // The pairing-code path reaches the same menu by a different leaf.
      expect(WhatsAppBaileysDriver.linkInstructions({ pairingCode: "ABCD-1234" })).toContain("Linked devices")
    }),
  )
})

// ── login (out-of-band QR/pairing → open) ────────────────────────────────────────────────────────

describe("WhatsAppBaileys login", () => {
  it.live("QR link: complete is retryable until the socket opens, then yields the exported session", () =>
    Effect.gen(function* () {
      const fake = makeFakeWA()
      const driver = WhatsAppBaileysDriver.make(factoryFor(fake))
      yield* Effect.scoped(
        Effect.gen(function* () {
          const pending = yield* driver.login!.begin({ account, inputs: {} }) // no phone → QR mode
          expect(pending.instructions).toContain("QR-BLOB-DATA")
          expect(fake.state.linkPhone).toBeUndefined()

          // Not linked yet → retryable "still waiting".
          const waiting = yield* pending.complete("").pipe(Effect.flip)
          expect(waiting._tag).toBe("MessengerDriver.LoginCodeError")
          if (waiting._tag === "MessengerDriver.LoginCodeError") expect(waiting.retryable).toBe(true)

          // The user scans → the socket opens → the fiber exports the auth.
          fake.resolveOpen()
          yield* Effect.sleep(Duration.millis(20))
          const done = yield* pending.complete("")
          expect(done.session).toBe("WA-SESSION-BLOB")
          expect(fake.state.exported).toBe(1)
        }),
      )
    }),
  )

  it.live("progress() republishes the ROTATED QR, so the wizard never shows an expired code", () =>
    Effect.gen(function* () {
      const fake = makeFakeWA()
      const driver = WhatsAppBaileysDriver.make(factoryFor(fake))
      yield* Effect.scoped(
        Effect.gen(function* () {
          const pending = yield* driver.login!.begin({ account, inputs: {} })
          expect(pending.progress).toBeDefined()
          const first = yield* pending.progress!()
          expect(first.instructions).toContain("QR-BLOB-DATA")
          expect(first.qrImage).toBeUndefined()

          // WhatsApp expires the ref ~20s in and Baileys emits the next one; the socket re-renders.
          fake.state.link = { qr: "QR-ROUND-2", qrImage: "data:image/png;base64,ROUND2" }
          const rotated = yield* pending.progress!()
          expect(rotated.qrImage).toBe("data:image/png;base64,ROUND2")
          expect(rotated.instructions).not.toContain("QR-BLOB-DATA")
        }),
      )
    }),
  )

  it.live("phone given → pairing-code mode; a logged-out link parks as a challenge", () =>
    Effect.gen(function* () {
      const fake = makeFakeWA()
      const driver = WhatsAppBaileysDriver.make(factoryFor(fake))
      yield* Effect.scoped(
        Effect.gen(function* () {
          const pending = yield* driver.login!.begin({ account, inputs: { phone: "+491701234567" } })
          expect(pending.instructions).toContain("ABCD-1234")
          expect(fake.state.linkPhone).toBe("+491701234567")

          // Let the forked waiter attach to waitForOpen() before we reject it (else the rejection is
          // momentarily unhandled — real use awaits it immediately inside the fiber).
          yield* Effect.sleep(Duration.millis(10))
          // The device is unlinked / banned before opening → a challenge (park, don't retry).
          fake.rejectOpen(new WAClientError({ kind: "logged-out" }))
          yield* Effect.sleep(Duration.millis(20))
          const failure = yield* pending.complete("").pipe(Effect.flip)
          expect(failure._tag).toBe("MessengerDriver.ChallengeError")
        }),
      )
    }),
  )
})

// ── connect (pump / send / listChats / challenge) ────────────────────────────────────────────────

describe("WhatsAppBaileys connect", () => {
  const signedIn = "WA-SESSION-BLOB"

  it.live("pump maps inbound; the self-chat message is the operator console (owner, self chat)", () =>
    Effect.gen(function* () {
      const fake = makeFakeWA()
      fake.enqueue([
        { chatID: "c1@g.us", chatKind: "group", chatTitle: "Team", messageID: "m1", senderID: "u1", senderName: "Alice", outgoing: false, text: "hi nova", at: 1000 },
        { chatID: "me@wa", chatKind: "dm", chatTitle: "You", messageID: "m2", senderID: "me@wa", senderName: "Me", outgoing: true, text: "Nova, status?", at: 1001 },
      ])
      const driver = WhatsAppBaileysDriver.make(factoryFor(fake))
      const seen: InboundView[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const conn = yield* driver.connect(ctxFor(signedIn))
          yield* Effect.forkScoped(
            conn.inbound.pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  if (event.kind === "message")
                    seen.push({ chatID: event.chat.chatID, self: event.chat.self === true, isSelf: event.sender.isSelf, owner: event.sender.owner === true, text: event.text })
                }),
              ),
            ),
          )
          yield* drainFor(() => seen, (s) => s.length >= 2, "two inbound events")
        }),
      )
      const incoming = seen.find((s) => s.chatID === "c1@g.us")!
      expect(incoming.isSelf).toBe(false)
      expect(incoming.text).toBe("hi nova")
      const selfChat = seen.find((s) => s.chatID === "me@wa")!
      expect(selfChat.self).toBe(true) // the Message-Yourself console
      expect(selfChat.isSelf).toBe(false) // operator input, NOT dropped as an echo
      expect(selfChat.owner).toBe(true)
    }),
  )

  it.live("send chunks long text, tracks our own sends, and files ride as a caption", () =>
    Effect.gen(function* () {
      const fake = makeFakeWA()
      const driver = WhatsAppBaileysDriver.make(factoryFor(fake))
      yield* Effect.scoped(
        Effect.gen(function* () {
          const conn = yield* driver.connect(ctxFor(signedIn))
          yield* conn.send("c1@g.us", { text: "x".repeat(9000) }) // > 4096 → chunks
          yield* conn.send("c1@g.us", { file: { name: "a.pdf", mime: "application/pdf", data: new Uint8Array([1]) }, text: "the file" })
        }),
      )
      const textSends = fake.state.sent.filter((entry) => !entry.file)
      expect(textSends.length).toBeGreaterThan(1) // chunked
      for (const entry of textSends) expect((entry.text ?? "").length).toBeLessThanOrEqual(4096)
      const fileSends = fake.state.sent.filter((entry) => entry.file)
      expect(fileSends).toHaveLength(1)
      expect(fileSends[0]?.text).toBe("the file") // caption
    }),
  )

  it.live("listChats renames the self-chat to 'Message Yourself' and marks it self", () =>
    Effect.gen(function* () {
      const fake = makeFakeWA()
      const driver = WhatsAppBaileysDriver.make(factoryFor(fake))
      const chats = yield* Effect.scoped(
        Effect.gen(function* () {
          const conn = yield* driver.connect(ctxFor(signedIn))
          return yield* conn.listChats!()
        }),
      )
      const selfChat = chats.find((chat) => chat.chatID === "me@wa")!
      expect(selfChat.title).toBe("Message Yourself")
      expect(selfChat.self).toBe(true)
    }),
  )

  it.live("a logged-out session PARKS as a challenge (never backoff-spins)", () =>
    Effect.gen(function* () {
      const fake = makeFakeWA()
      fake.state.meThrows = new WAClientError({ kind: "logged-out" })
      const driver = WhatsAppBaileysDriver.make(factoryFor(fake))
      const failure = yield* driver.connect(ctxFor(signedIn)).pipe(Effect.scoped, Effect.flip)
      expect(failure._tag).toBe("MessengerDriver.ChallengeError")
    }),
  )
})

interface InboundView {
  readonly chatID: string
  readonly self: boolean
  readonly isSelf: boolean
  readonly owner: boolean
  readonly text?: string
}
