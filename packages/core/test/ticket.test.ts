import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { PtyID } from "@novaclaw/core/pty/schema"
import { Ticket } from "@novaclaw/core/ticket"
import { WorkspaceV2 } from "@novaclaw/core/workspace"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Ticket.node))
const itExpiring = testEffect(
  LayerNode.compile(Ticket.node, [[Ticket.node, Layer.effect(Ticket.Service, Ticket.make(5))]]),
)

describe("single-use tickets", () => {
  it.live("consumes tickets once", () =>
    Effect.gen(function* () {
      const tickets = yield* Ticket.Service
      const scope = { kind: "pty.connect", ptyID: PtyID.ascending(), directory: "/tmp/a" } as const
      const issued = yield* tickets.issue(scope)

      expect(yield* tickets.consume(scope, issued.ticket)).toBe(true)
      expect(yield* tickets.consume(scope, issued.ticket)).toBe(false)
    }),
  )

  it.live("rejects tickets scoped to a different request", () =>
    Effect.gen(function* () {
      const tickets = yield* Ticket.Service
      const ptyID = PtyID.ascending()
      const issued = yield* tickets.issue({ kind: "pty.connect", ptyID, directory: "/tmp/a" })

      expect(yield* tickets.consume({ kind: "pty.connect", ptyID, directory: "/tmp/b" }, issued.ticket)).toBe(false)
      expect(yield* tickets.consume({ kind: "pty.connect", ptyID, directory: "/tmp/a" }, issued.ticket)).toBe(true)
    }),
  )

  itExpiring.live("rejects tickets after the TTL elapses", () =>
    Effect.gen(function* () {
      const tickets = yield* Ticket.Service
      const ptyID = PtyID.ascending()
      const issued = yield* tickets.issue({ kind: "pty.connect", ptyID })

      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)))

      expect(yield* tickets.consume({ kind: "pty.connect", ptyID }, issued.ticket)).toBe(false)
    }),
  )

  it.live("rejects tickets scoped to a different workspace", () =>
    Effect.gen(function* () {
      const tickets = yield* Ticket.Service
      const ptyID = PtyID.ascending()
      const workspaceID = WorkspaceV2.ID.ascending()
      const issued = yield* tickets.issue({ kind: "pty.connect", ptyID, workspaceID })

      expect(
        yield* tickets.consume({ kind: "pty.connect", ptyID, workspaceID: WorkspaceV2.ID.ascending() }, issued.ticket),
      ).toBe(false)
      expect(yield* tickets.consume({ kind: "pty.connect", ptyID, workspaceID }, issued.ticket)).toBe(true)
    }),
  )

  /**
   * 🔴 A file ticket must not open a terminal, and the two scopes are otherwise shaped alike.
   *
   * The store this generalises compared scopes property by property, so `kind` would have been just
   * another field to forget. It is compared here because EVERY property is.
   */
  it.live("a ticket is refused by a different kind of route", () =>
    Effect.gen(function* () {
      const tickets = yield* Ticket.Service
      const directory = "/tmp/a"
      const issued = yield* tickets.issue({ kind: "fs.read", path: "report.pdf", directory })

      expect(yield* tickets.consume({ kind: "pty.connect", ptyID: "report.pdf", directory }, issued.ticket)).toBe(false)
      expect(yield* tickets.consume({ kind: "fs.read", path: "report.pdf", directory }, issued.ticket)).toBe(true)
    }),
  )

  it.live("a file ticket is refused for a different file in the same directory", () =>
    Effect.gen(function* () {
      const tickets = yield* Ticket.Service
      const directory = "/tmp/a"
      const issued = yield* tickets.issue({ kind: "fs.read", path: "public.txt", directory })

      expect(yield* tickets.consume({ kind: "fs.read", path: "secrets.env", directory }, issued.ticket)).toBe(false)
      expect(yield* tickets.consume({ kind: "fs.read", path: "public.txt", directory }, issued.ticket)).toBe(true)
    }),
  )

  it.live("a ticket nobody issued is refused", () =>
    Effect.gen(function* () {
      const tickets = yield* Ticket.Service
      // Control: without this the four assertions above are also satisfied by a store that says
      // `true` for the first presentation of ANY string and `false` afterwards.
      expect(yield* tickets.consume({ kind: "fs.read", path: "a.txt", directory: "/tmp" }, crypto.randomUUID())).toBe(
        false,
      )
    }),
  )

  /**
   * An absent location and an explicitly-`undefined` one are the SAME scope.
   *
   * Both spellings reach the store in production — the PTY handler spreads a record that always
   * carries `directory` and `workspaceID`, the FS handler builds the literal — and a canonicaliser
   * that serialised `undefined` would refuse a ticket it had just minted, which reads in the browser
   * as "download is broken sometimes".
   */
  it.live("an undefined scope field is the same scope as an absent one", () =>
    Effect.gen(function* () {
      const tickets = yield* Ticket.Service
      const issued = yield* tickets.issue({ kind: "fs.read", path: "a.txt", directory: "/tmp" })

      expect(
        yield* tickets.consume(
          { kind: "fs.read", path: "a.txt", directory: "/tmp", workspaceID: undefined },
          issued.ticket,
        ),
      ).toBe(true)
    }),
  )
})
