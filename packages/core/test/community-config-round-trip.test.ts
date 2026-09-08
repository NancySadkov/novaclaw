import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@novaclaw/core/config"

/**
 * 🔴 Every community setting the code READS must survive the config schema.
 *
 * This exists because the failure is total and silent, and it happened twice. `community.answers`
 * was read by the gate and never declared here, so a write succeeded, the value was STRIPPED, and
 * the capability could not be switched on by anybody — with the whole suite green, because every
 * test set the gate in-process instead of through configuration.
 *
 * ⚠️ A schema that drops a field is indistinguishable from a value that was never written, from a
 * stale backend, and from a feature that does not work. Which is why the assertion is a ROUND TRIP
 * rather than a list of names: it fails for exactly the reason the bug existed.
 */

const decode = Schema.decodeUnknownSync(Config.Info)

/**
 * One value per key the community code actually reads today, each traceable to its reader:
 *
 *   consented / enabled          → `community/consent.ts`  (participation)
 *   answers.*                    → `community/answer.ts`   (the token-spending gate and its budget)
 *   seeds.*                      → the discover handler    (the default door, and refusing it)
 *   announce                     → the discover handler    (the address published to the public DHT)
 *
 * ⚠️ Adding a reader without adding it here leaves the same hole open, so the list is part of the
 * change rather than an afterthought — the same discipline the framing and orphan ledgers use.
 */
const EVERY_COMMUNITY_SETTING = {
  consented: true,
  enabled: true,
  answers: { enabled: true, perDay: 7, perPeerPerDay: 3 },
  seeds: { enabled: false, host: "my-own-zone.example" },
  announce: "203.0.113.9:4096",
} as const

describe("community settings survive the config schema", () => {
  test("🔴 every declared key round-trips with its value intact", () => {
    const decoded = decode({ community: EVERY_COMMUNITY_SETTING })
    expect(decoded.community).toEqual(EVERY_COMMUNITY_SETTING)
  })

  test("🔴 each key individually — so one survivor cannot mask a dropped sibling", () => {
    /**
     * ⚠️ Whole-object equality alone would pass if a nested object were dropped and re-added by a
     * default, and would report one failure for several causes. Per key, the failure names itself.
     */
    for (const [key, value] of Object.entries(EVERY_COMMUNITY_SETTING)) {
      const decoded = decode({ community: { [key]: value } })
      const seen = (decoded.community as Record<string, unknown> | undefined)?.[key]
      expect(seen, `community.${key} was DROPPED by the config schema`).toEqual(value as never)
    }
  })

  test("🔴 an undeclared key is DROPPED IN SILENCE — which is why the checks above exist", () => {
    /**
     * I expected this to throw, and it does not. An unknown key is discarded without a word, so a
     * user who sets something the schema never heard of gets no error, no warning, and no effect
     * — identical to the feature being broken.
     *
     * ⚠️ That is the mechanism behind both incidents, stated as a test rather than as a memory:
     * declaring a setting is not documentation, it is the thing that makes the setting exist. The
     * per-key round trip above is the only guard, because nothing in the write path will complain.
     *
     * ⚠️ Worth the owner's attention as a product question, not fixed here: a strict schema
     * would report a typo in a settings file to whoever typed it, at the cost of refusing configs
     * that older builds accepted. That trade is theirs to make, not a thing to change quietly under
     * a test.
     */
    const decoded = decode({ community: { notARealSetting: true } })
    expect((decoded.community as Record<string, unknown> | undefined)?.notARealSetting).toBeUndefined()
  })
})
