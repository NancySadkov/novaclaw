export * as CommunityObservation from "./observation"

import { desc, inArray } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { CommunityContactTable, CommunityObservationTable, CommunitySuccessionTable } from "./sql"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { Identifier } from "../id/id"

/**
 * Community — HONESTY, the per-peer ledger (`notes/spec/honesty-ledger.md`).
 *
 * 🔴 This records DEALINGS and derives nothing. There is no score here, and no function that returns
 * one, because the mechanism for turning dealings into standing is deliberately still open — the
 * owner's constraint is that implementation details align with the vision rather than settle early
 * into a premature conception of it. What is settled is the substrate: raw facts in, raw facts out,
 * and any policy at all can be written on top without a migration.
 *
 * ⚠️ **It can introduce nobody.** `community_contact` is the user's sentence about who they know;
 * this is the instance's sentence about how dealings went, and a good reputation is not an
 * introduction. `CommunityContacts.observe` and `follow` already refuse to mint a contact from
 * anything the network says, and nothing here may do it either.
 */

export interface Observation {
  readonly id: string
  /** The peer BY THE KEY THEY HELD AT THE TIME — see `record`. */
  readonly subject: string
  /** Epoch millis the dealing happened, which is not when the row was written. */
  readonly at: number
  /** What kind of dealing this was. Free text: the taxonomy is the agent's, not the schema's. */
  readonly context: string
  /** The coarse result, for counting. */
  readonly outcome: string
  /** The agent's own words. ⚠️ May quote a peer, so it is fence-worthy wherever it is rendered. */
  readonly note?: string
  /** The message or claim this is about, when there is one. */
  readonly about?: string
}

export interface Input {
  readonly subject: string
  readonly at: number
  readonly context: string
  readonly outcome: string
  readonly note?: string
  readonly about?: string
}

export interface Interface {
  /**
   * Record a dealing.
   *
   * ⚠️ `subject` is stored VERBATIM, not resolved to the peer's current key first. Resolving on write
   * would rewrite history at every rotation, and the whole defence against a fresh face is that the
   * past stays attached to the person who earned it.
   */
  readonly record: (input: Input) => Effect.Effect<string>
  /**
   * Every dealing with this PERSON, newest first — by any key they have ever held.
   *
   * The caller may pass any key in the chain and gets the same answer, which is what makes rotation
   * non-laundering at the point where it would otherwise pay off.
   */
  readonly about: (networkID: string) => Effect.Effect<ReadonlyArray<Observation>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunityObservation") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    /**
     * Every key one person has held, walked in BOTH directions from whichever key the caller has.
     *
     * 🔴 Two sources, and the second is not redundant. Succession statements are the general record,
     * but they are capped and evicted oldest-first; a contact's `successor_id` is never evicted at
     * all, and only the user's explicit forget removes it. Reading both means a contact's chain
     * survives pressure that would break a stranger's — and that asymmetry is exactly why the
     * eviction bound had to learn about this table (see `succession.MAX_STATEMENTS`).
     *
     * ⚠️ `seen` is cycle protection, not decoration. A fork cannot normally be stored — a key rotates
     * once — but the two sources are written by different code paths, and a walk that trusted them to
     * agree would hang rather than answer.
     */
    const chain = Effect.fn("CommunityObservation.chain")(function* (networkID: string) {
      const forward = new Map<string, string>()
      const statements = yield* db
        .select({
          predecessor: CommunitySuccessionTable.network_id,
          successor: CommunitySuccessionTable.successor_id,
        })
        .from(CommunitySuccessionTable)
        .all()
        .pipe(Effect.orDie)
      for (const row of statements) forward.set(row.predecessor, row.successor)

      const contacts = yield* db
        .select({
          predecessor: CommunityContactTable.network_id,
          successor: CommunityContactTable.successor_id,
        })
        .from(CommunityContactTable)
        .all()
        .pipe(Effect.orDie)
      for (const row of contacts) if (row.successor !== null) forward.set(row.predecessor, row.successor)

      const backward = new Map<string, string>()
      for (const [predecessor, successor] of forward) backward.set(successor, predecessor)

      const keys = new Set([networkID])
      for (const edges of [forward, backward]) {
        let current = networkID
        for (;;) {
          const next = edges.get(current)
          if (next === undefined || keys.has(next)) break
          keys.add(next)
          current = next
        }
      }
      return [...keys]
    })

    return Service.of({

      record: Effect.fn("CommunityObservation.record")(function* (input: Input) {
        const id = Identifier.ascending("observation")
        yield* db
          .insert(CommunityObservationTable)
          .values({
            id,
            subject: input.subject,
            observed_at: input.at,
            context: input.context,
            outcome: input.outcome,
            ...(input.note === undefined ? {} : { note: input.note }),
            ...(input.about === undefined ? {} : { about: input.about }),
          })
          .run()
          .pipe(Effect.orDie)
        return id
      }),

      about: Effect.fn("CommunityObservation.about")(function* (networkID: string) {
        const keys = yield* chain(networkID)
        const rows = yield* db
          .select()
          .from(CommunityObservationTable)
          .where(inArray(CommunityObservationTable.subject, keys))
          .orderBy(desc(CommunityObservationTable.observed_at))
          .all()
          .pipe(Effect.orDie)
        return rows.map(
          (row): Observation => ({
            id: row.id,
            subject: row.subject,
            at: row.observed_at,
            context: row.context,
            outcome: row.outcome,
            ...(row.note === null ? {} : { note: row.note }),
            ...(row.about === null ? {} : { about: row.about }),
          }),
        )
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
