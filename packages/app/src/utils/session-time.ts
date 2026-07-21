// The client stores' contract for `Session.Info.time` is EPOCH MILLIS (the REST encoding of
// `DateTimeUtcFromMillis`). The live SSE mirror, however, carries the publisher's TYPE-SIDE
// payload (EventV2 publishes decoded values; only the durable replay path re-encodes), so
// DateTime fields serialize as ISO STRINGS on that wire. A record folded from a live event
// therefore violated the store contract, and time math crashed the Chats pane
// (owner-hit 2026-07-21: `DateTime.fromMillis` threw on "2026-07-21T21:19:58.352Z" in
// `groupSessions`, faulting the whole sessions list). Every fold normalizes through here so a
// mixed-encoding record can never enter a store again. The wire-side cleanup (encoding events
// before the SSE mirror) is filed in todo.md — until then this boundary owns the contract.

type TimeLike = number | string | undefined

const toMillis = (value: TimeLike): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value === "number") return value
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Coerce a session record's time fields to epoch millis; returns the input untouched when
 *  already conformant (keeps referential stability for `reconcile`). */
export function normalizeSessionTimes<T extends { time?: { created?: unknown; updated?: unknown; archived?: unknown } }>(
  info: T,
): T {
  const time = info?.time
  if (!time) return info
  const conformant =
    typeof time.created !== "string" && typeof time.updated !== "string" && typeof time.archived !== "string"
  if (conformant) return info
  return {
    ...info,
    time: {
      ...time,
      created: toMillis(time.created as TimeLike) ?? time.created,
      updated: toMillis(time.updated as TimeLike) ?? time.updated,
      ...(time.archived === undefined ? {} : { archived: toMillis(time.archived as TimeLike) ?? time.archived }),
    },
  }
}

/** Tolerant read of a session time value for sort/group math (millis in, millis out; ISO tolerated). */
export function sessionTimeMillis(value: number | string): number {
  return typeof value === "number" ? value : (toMillis(value) ?? 0)
}
