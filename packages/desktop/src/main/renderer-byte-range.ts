export function parseRendererByteRange(value: string, size: number): { start: number; end: number } | undefined {
  if (!Number.isSafeInteger(size) || size <= 0) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2])) return undefined
  const first = match[1] ? Number(match[1]) : undefined
  const last = match[2] ? Number(match[2]) : undefined
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last)))
    return undefined
  if (first === undefined) {
    if (last === undefined || last <= 0) return undefined
    return { start: Math.max(0, size - last), end: size - 1 }
  }
  if (first >= size || (last !== undefined && last < first)) return undefined
  return { start: first, end: Math.min(last ?? size - 1, size - 1) }
}
