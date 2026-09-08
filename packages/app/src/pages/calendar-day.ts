/** Preserve the draft text until submit, then accept only a real calendar day. */
export function calendarDay(raw: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 31) throw new Error("Choose a whole day from 1 to 31")
  return value
}
