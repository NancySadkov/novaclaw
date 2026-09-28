export function startupServerKey(value: string | null | undefined): string {
  if (!value) return "sidecar"
  try {
    const url = new URL(value)
    if (url.protocol === "http:" || url.protocol === "https:") return value
  } catch {}
  return "sidecar"
}
