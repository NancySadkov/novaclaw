import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"

import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

/**
 * **`community.announce` must survive the WHOLE chain, not just the schema.**
 *
 * 🔴 This is the third time a community setting has crossed this seam, and the first two both
 * failed here rather than in any schema: `community.answers` was read by its gate and never declared,
 * so the PATCH answered 200 and the value was STRIPPED — the capability was unreachable by anybody
 * while the suite was green. `contact.trust` was declared and then not forwarded by the handler,
 * answering 200 with the old value intact.
 *
 * ⚠️ So this writes through the real route and READS THE VALUE BACK. A 200 proved nothing in either
 * incident, and a schema round-trip (`community-config-round-trip.test.ts`) proves only that the
 * shape survives decoding — not that a running instance can store and return it.
 *
 * 🔴 Why this key in particular: it is the one that makes an instance FINDABLE. If it cannot be
 * stored, discovery looks and never publishes, the DHT room stays empty, and everything downstream
 * looks like a network with nobody in it — a failure with no error message anywhere.
 */

const it = testEffectShared(Layer.mergeAll(Database.defaultLayer, httpApiLayer))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const patch = (body: unknown) => ({
  method: "PATCH" as const,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const ADDRESS = "203.0.113.9:4096"

describe("community.announce across the HTTP seam", () => {
  /**
   * ⚠️ ONE test, in order, rather than three that each assume a clean instance.
   *
   * This package's preload pins `NOVACLAW_DB=":memory:"` for every test, so all directories share a
   * single database and the settings behind it — a second `it.instance` gets a fresh temp directory
   * and the PREVIOUS test's configuration. Measured while writing this file: a "fresh instance"
   * read back an address written by the case above it, and an existing key (`username`) leaks the
   * same way, so it is the fixture and not this feature. A default asserted in its own case would
   * therefore pass or fail on execution ORDER, which is worse than not asserting it.
   */
  it.instance("🔴 default absent, then written and READ BACK, then taken away", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance

      const before = JSON.parse(yield* (yield* requestInDirectory("/config", test.directory)).text) as {
        community?: { announce?: string }
      }
      expect(before.community?.announce, "nobody is published because the software felt like it").toBeUndefined()

      const written = yield* requestInDirectory("/config", test.directory, patch({ community: { announce: ADDRESS } }))
      expect(written.status, "the write itself must succeed").toBe(200)

      /**
       * 🔴 The VALUE, not the status. `community.answers` answered 200 on a write that was thrown
       * away, which is exactly what this assertion distinguishes — and it is the assertion that
       * would have caught it.
       */
      const after = JSON.parse(yield* (yield* requestInDirectory("/config", test.directory)).text) as {
        community?: { announce?: string }
      }
      expect(after.community?.announce, "the address was accepted and then lost").toBe(ADDRESS)

      // Reversible: a user who moves, loses a port forward, or changes their mind must be able to
      // stop advertising without turning the community off.
      yield* requestInDirectory("/config", test.directory, patch({ community: { announce: "" } }))
      const cleared = JSON.parse(yield* (yield* requestInDirectory("/config", test.directory)).text) as {
        community?: { announce?: string }
      }
      expect(cleared.community?.announce, "an emptied address must not keep advertising").toBe("")
    }),
  )
})
