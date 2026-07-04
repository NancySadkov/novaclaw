// Inlined from the removed TUI package (util/record). TUI retired; HTML-UI-only.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
