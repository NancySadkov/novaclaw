import { describe, expect } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { Effect } from "effect"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { Database } from "@novaclaw/core/database/database"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { testEffect } from "./lib/effect"

/**
 * 🔴 **"You can block people, and that is the only power anyone has here."**
 *
 * That is what the consent screen promises, and it was untrue for the case it matters most in.
 * `setBlocked` UPDATED a contact row and did nothing when there was none, so somebody who found this
 * instance through the public directory and started asking questions could not be blocked at all —
 * the user had to ADD the person they wanted nothing to do with, first.
 *
 * ⚠️ Resolved through the vision rather than escalated. (ff) constrains AUTONOMY — *"autonomy may
 * deepen a relationship the user made and may never make one"* — and the doorman door already records
 * the other side: when the USER makes the relationship, a contact may be created, because *"refusing
 * to record that would be enforcing a rule against the only party it exists to protect."*
 */

const it = testEffect(
  LayerNode.compile(LayerNode.group([Database.node, InstanceIdentityStore.node, CommunityContacts.node])),
)

const stranger = () => {
  const { publicKey } = generateKeyPairSync("ed25519")
  const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(12)
  return `nid_${raw.toString("base64url")}`
}

describe("blocking somebody you have never added", () => {
  it.effect("🔴 works, and the block is what gets recorded", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const nobody = stranger()

      expect(yield* contacts.setBlocked(nobody, true), "blocking a stranger must succeed").toBe(true)

      const listed = (yield* contacts.list()).find((entry) => entry.networkID === nobody)
      expect(listed?.blocked, "and it must be visible as blocked, not silently stored").toBe(true)
      // ⚠️ Nothing else is invented about them: no petname the user never typed, no route.
      expect(listed?.petname).toBeUndefined()
      expect(listed?.routes).toEqual([])
    }),
  )

  it.effect("🔴 a blocked stranger is not a bootstrap entry", () =>
    Effect.gen(function* () {
      /**
       * The row must not become a way back IN. `bootstrap()` already drops blocked contacts and ones
       * with no routes, so this holds twice over — asserted because a row created for refusal turning
       * into an entry point would be the exact opposite of what the user asked for.
       */
      const contacts = yield* CommunityContacts.Service
      const nobody = stranger()
      yield* contacts.setBlocked(nobody, true)
      expect((yield* contacts.bootstrap()).some((entry) => entry.networkID === nobody)).toBe(false)
    }),
  )

  it.effect("⚠️ UN-blocking a stranger stays a no-op — no row for a decision nobody made", () =>
    Effect.gen(function* () {
      // Minting a row to record the absence of a decision would be a dossier nobody asked for.
      const contacts = yield* CommunityContacts.Service
      const nobody = stranger()
      expect(yield* contacts.setBlocked(nobody, false)).toBe(false)
      expect((yield* contacts.list()).some((entry) => entry.networkID === nobody)).toBe(false)
    }),
  )

  it.effect("⚠️ an id that is not a KEY is refused — blocking it would guard nothing", () =>
    Effect.gen(function* () {
      /**
       * The reason `add` gives: an id that cannot parse as a public key can never have a signature
       * verified against it, so a row for it silently protects the user from nobody. A typo must not
       * mint one.
       */
      const contacts = yield* CommunityContacts.Service
      expect(yield* contacts.setBlocked("nid_not-a-real-key", true)).toBe(false)
      expect(yield* contacts.setBlocked("bob", true)).toBe(false)
      expect((yield* contacts.list()).length, "and nothing was stored for either").toBe(0)
    }),
  )

  it.effect("⚠️ and the control: blocking an EXISTING contact still updates rather than duplicates", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const known = stranger()
      yield* contacts.add({ networkID: known, petname: "someone" })
      expect(yield* contacts.setBlocked(known, true)).toBe(true)

      const rows = (yield* contacts.list()).filter((entry) => entry.networkID === known)
      expect(rows.length, "one person, one row").toBe(1)
      expect(rows[0]?.blocked).toBe(true)
      expect(rows[0]?.petname, "and what the user typed survives being blocked").toBe("someone")
    }),
  )
})
