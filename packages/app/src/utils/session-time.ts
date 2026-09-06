import * as Timestamp from "@novaclaw/schema/time"

// The client stores' contract for `Session.Info.time` is EPOCH MILLIS (the REST encoding of
// `DateTimeUtcFromMillis`). Older event/cache inputs and decoded in-process values can instead carry
// ISO strings or Effect DateTime values. A record folded from one of those inputs violated the store
// contract, and time math crashed the Chats pane
// (owner-hit 2026-07-21: `DateTime.fromMillis` threw on "2026-07-21T21:19:58.352Z" in
// `groupSessions`, faulting the whole sessions list). Every fold normalizes through here so a
// mixed-encoding record can never enter a store again.

/** Coerce a session record's time fields to epoch millis; returns the input untouched when
 *  already conformant (keeps referential stability for `reconcile`). */
export function normalizeSessionTimes<
  T extends { time?: { created?: unknown; updated?: unknown; archived?: unknown } },
>(info: T): T {
  const time = info?.time
  if (!time) return info
  const created = Timestamp.toEpochMillis(time.created)
  const updated = Timestamp.toEpochMillis(time.updated)
  const archived = Timestamp.toEpochMillis(time.archived)
  const conformant = created === time.created && updated === time.updated && archived === time.archived
  if (conformant) return info
  return {
    ...info,
    time: {
      ...time,
      created: created ?? time.created,
      updated: updated ?? time.updated,
      ...(time.archived === undefined ? {} : { archived: archived ?? time.archived }),
    },
  }
}

/** Tolerant read of a session time value for sort/group math (millis in, millis out; ISO tolerated). */
export function sessionTimeMillis(value: unknown): number {
  return Timestamp.toEpochMillis(value) ?? 0
}
