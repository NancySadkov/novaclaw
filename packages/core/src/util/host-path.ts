export function fromBashDrive(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return value
  const match = /^\/([A-Za-z])(?:\/(.*))?$/.exec(value)
  return match ? `${match[1]!.toUpperCase()}:/${match[2] ?? ""}` : value
}
