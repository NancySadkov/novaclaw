/**
 * The one boundary for instants that may have crossed NovaClaw's Effect-schema or JSON seams.
 *
 * Type-side `DateTimeUtcFromMillis` values are Effect `DateTime.Utc` carriers, encoded REST/SSE
 * values are epoch-millisecond numbers, and older live clients may still supply ISO strings. Code
 * that formats, compares, or subtracts one of those values must normalize it here first. Keeping the
 * accepted shapes in one place prevents a new transport path from teaching every consumer another
 * private timestamp dialect.
 */

export type Input = number | string | Date | { readonly epochMillis: unknown }

/** Convert a supported instant to finite epoch milliseconds. Unknown or malformed input stays unknown. */
export function toEpochMillis(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string") {
    if (value.trim() === "") return undefined
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (value instanceof Date) {
    const parsed = value.getTime()
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const parsed = (value as { readonly epochMillis?: unknown }).epochMillis
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined
}

/** Construct a valid Date from any supported instant. */
export function toDate(value: unknown): Date | undefined {
  const millis = toEpochMillis(value)
  if (millis === undefined) return undefined
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/** Format an instant for a machine-readable HTML/log boundary. */
export function toISOString(value: unknown): string | undefined {
  return toDate(value)?.toISOString()
}

/** Subtract two supported instants. A negative result is valid; policy such as clamping belongs to the caller. */
export function elapsedMillis(started: unknown, ended: unknown): number | undefined {
  const start = toEpochMillis(started)
  const end = toEpochMillis(ended)
  return start === undefined || end === undefined ? undefined : end - start
}
