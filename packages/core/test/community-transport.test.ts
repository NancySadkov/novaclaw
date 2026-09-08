import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { CommunityTransport, MAX_ANSWER_BYTES, answerTooLarge } from "@novaclaw/core/community/transport"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { CommunityMessage } from "@novaclaw/core/community/message"
import { CommunityWork } from "@novaclaw/core/community/work"
import { Offline } from "@novaclaw/core/offline"
import { testEffect } from "./lib/effect"

/**
 * Community P2 — the transport seam (`notes/spec/community-p2p.md`).
 *
 * The transport is now real — plain HTTPS to reachable instances — so these pin the states of an
 * instance that HAS one and still cannot send: nobody to dial, or airgap. Both are ordinary, and
 * neither may be reported as a failure.
 */

/**
 * 🔴 These instances have JOINED. The transport does not carry anything for an instance whose owner
 * has not accepted what joining costs, so without this every case below would report `not-joined`
 * and the airgap distinction under test would be invisible.
 *
 * ⚠️ Granted through the same function the config write path uses, so this exercises the real gate.
 */
const joined = () => CommunityConsent.applied({ consented: true }, { enabled: false })

const it = testEffect(
  // Offline is listed explicitly as well as being a dependency of the transport: the airgap case
  // drives it directly, and a service that is only a transitive dep is not in scope for the test.
  LayerNode.compile(
    LayerNode.group([Database.node, InstanceIdentityStore.node, Offline.node, CommunityTransport.node]),
  ),
)

describe("CommunityTransport", () => {
  it.effect("reports OFF with a reason, not a failure", () =>
    Effect.gen(function* () {
      joined()
      const transport = yield* CommunityTransport.Service
      const state = yield* transport.state()
      // ⚠️ `no-peers`, not `none`. A transport exists and works; this instance simply knows nobody
      // with an address to dial, which is a fresh install and is something the user can fix in a
      // minute. Modelling either as an error would make the Community screen red on first open.
      expect(state).toEqual({ kind: "off", reason: "no-peers" })
    }),
  )

  it.effect("🔴 publishing returns false rather than failing", () =>
    Effect.gen(function* () {
      joined()
      const transport = yield* CommunityTransport.Service
      // PROVEN, because `publish` demands it: handing a transport a message without its work would
      // publish something every receiver refuses, and the failure would show only on the far side.
      const message = CommunityWork.prove(
        yield* CommunityMessage.sign({ channel: "#NovaClaw", body: "into the void" }),
      )!
      // The caller keeps its own copy either way, so the user's words are never lost — they simply
      // have no audience yet. A failing effect here would surface as a crash on a normal action.
      expect(yield* transport.publish(message)).toBe(false)
    }),
  )

  it.effect("🔴 AIRGAP is reported distinctly from 'nobody to dial'", () =>
    Effect.gen(function* () {
      joined()
      const transport = yield* CommunityTransport.Service
      const before = yield* transport.state()
      expect(before).toEqual({ kind: "off", reason: "no-peers" })

      // A community is egress the user chose, so airgap must be able to withdraw that choice — and
      // the reason has to survive to the UI, because "off because you turned the network off" and
      // "off because you have not added anyone yet" are different things to tell someone.
      const offline = yield* Offline.Service
      const original = offline.policy.enabled
      try {
        Object.defineProperty(offline.policy, "enabled", { value: true, configurable: true })
        expect(yield* transport.state()).toEqual({ kind: "off", reason: "airgap" })
      } finally {
        Object.defineProperty(offline.policy, "enabled", { value: original, configurable: true })
      }

      // And it follows the flag back down without a restart: the policy is read per call, so a
      // Settings change takes effect immediately rather than reporting stale.
      expect(yield* transport.state()).toEqual({ kind: "off", reason: "no-peers" })
    }),
  )

  it.effect("🔴 the three OFF reasons stay distinct — each sends the user somewhere else", () =>
    Effect.gen(function* () {
      /**
       * `airgap` → turn off offline mode. `not-joined` → open the Community app and read the warning.
       * `no-peers` → go and find somebody. Collapsing any two sends a person to fix a thing that is
       * already correct.
       *
       * 🔴 This existed as a defect for exactly one commit: gating the transport on participation
       * made `state` report "airgap" for an instance that simply had not joined, on a surface the
       * agent tool and the API both read. Nothing asserted the difference, so nothing caught it —
       * the same argument the refusals ARRAY makes one layer up, which is why this pins all three.
       */
      const transport = yield* CommunityTransport.Service
      const offline = yield* Offline.Service

      // NOT JOINED — the state of a fresh install, before anything else can be true.
      CommunityConsent.resetGate()
      expect(yield* transport.state()).toEqual({ kind: "off", reason: "not-joined" })

      // JOINED, nobody to dial — the ordinary state of a new user who has accepted.
      joined()
      expect(yield* transport.state()).toEqual({ kind: "off", reason: "no-peers" })

      /**
       * ⚠️ AIRGAP outranks both: the machine-level switch is not a community setting, and reporting
       * "no-peers" while it is on would hide the only thing that matters.
       *
       * Forced the way the airgap case above forces it — a property on the live policy — because the
       * gate reads `Offline.currentPolicy()` directly, which is the same object.
       */
      const original = offline.policy.enabled
      try {
        Object.defineProperty(offline.policy, "enabled", { value: true, configurable: true })
        expect(yield* transport.state()).toEqual({ kind: "off", reason: "airgap" })
      } finally {
        Object.defineProperty(offline.policy, "enabled", { value: original, configurable: true })
      }
    }),
  )
})

describe("an ANSWER has its own ceiling", () => {
  test("🔴 the sync limit is not the answer limit", () => {
    /**
     * 🔴 4 MB is DERIVED from `sync/messages` — 256 messages at 8 KB — and reusing it for a
     * single answer accepts five hundred times what an honest answerer can produce: the answering
     * side bounds itself by `maxTokens`, 2048 by default, which is about 8 KB of text.
     *
     * ⚠️ The agent's context is protected downstream, because tool output is truncated centrally.
     * What this bounds is what we TRANSFER, HOLD and VERIFY before that — a signature check runs
     * over whatever arrived.
     */
    const oneMegabyte = { "content-length": String(1024 * 1024) }
    expect(answerTooLarge(oneMegabyte), "a megabyte is fine for a page of messages").toBe(false)
    expect(answerTooLarge(oneMegabyte, MAX_ANSWER_BYTES), "and absurd for one answer").toBe(true)
  })

  test("⚠️ a long but honest answer still fits", () => {
    // Eight times the honest maximum: room for a verbose reply, none for a payload.
    expect(answerTooLarge({ "content-length": String(8 * 1024) }, MAX_ANSWER_BYTES)).toBe(false)
    expect(answerTooLarge({ "content-length": String(MAX_ANSWER_BYTES) }, MAX_ANSWER_BYTES)).toBe(false)
    expect(answerTooLarge({ "content-length": String(MAX_ANSWER_BYTES + 1) }, MAX_ANSWER_BYTES)).toBe(true)
  })

  test("⚠️ an answer that declares NO length is refused at either ceiling", () => {
    // The reason the inbound limiter gives: every honest responder is an instance answering with a
    // JSON string, which always sets it.
    expect(answerTooLarge({}, MAX_ANSWER_BYTES)).toBe(true)
    expect(answerTooLarge({})).toBe(true)
  })
})
