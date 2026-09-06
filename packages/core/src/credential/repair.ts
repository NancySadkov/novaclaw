export * as CredentialRepair from "./repair"

import { Effect } from "effect"

export type Unreadable = { readonly path: string }
export type ScanSource = {
  readonly name: string
  readonly rows: () => Effect.Effect<ReadonlyArray<{ readonly path: string; readonly value: unknown }>, unknown>
  readonly validate: (path: string, value: unknown) => Effect.Effect<unknown, unknown>
}

/** Report malformed secrets by path. A failed scan remains visible, never a false healthy result. */
export const scanSource = (source: ScanSource): Effect.Effect<ReadonlyArray<Unreadable>> =>
  source.rows().pipe(
    Effect.flatMap((rows) =>
      Effect.forEach(
        rows,
        (row) =>
          source.validate(row.path, row.value).pipe(
            Effect.as([] as Unreadable[]),
            Effect.catchCause(() => Effect.succeed([{ path: row.path }])),
          ),
        { concurrency: 1 },
      ),
    ),
    Effect.map((found) => found.flat()),
    Effect.catchCause(() => Effect.succeed([{ path: source.name }])),
  )

export const dedupe = (items: ReadonlyArray<Unreadable>): ReadonlyArray<Unreadable> => {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.path)) return false
    seen.add(item.path)
    return true
  })
}

export const scan = (sources: ReadonlyArray<ScanSource>): Effect.Effect<ReadonlyArray<Unreadable>> =>
  Effect.forEach(sources, scanSource, { concurrency: 1 }).pipe(Effect.map((all) => dedupe(all.flat())))

export function notice(unreadable: ReadonlyArray<Unreadable>): string | undefined {
  if (unreadable.length === 0) return undefined
  return (
    `${unreadable.length} stored ${unreadable.length === 1 ? "secret cannot" : "secrets cannot"} be read or checked. ` +
    "Reconnect the affected accounts or replace their credentials. For an instance identity, restore an identity backup in Community settings."
  )
}
