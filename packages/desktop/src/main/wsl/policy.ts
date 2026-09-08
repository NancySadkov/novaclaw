import type { WslDistroProbe, WslNovaclawCheck, WslServerItem } from "../../preload/types"

export function wslServerIdToRestart(servers: WslServerItem[], distro: string) {
  return servers.find((item) => item.config.distro === distro)?.config.id
}

export function clearWslDistroState(
  distroProbes: Record<string, WslDistroProbe>,
  novaclawChecks: Record<string, WslNovaclawCheck>,
  distro: string,
) {
  const nextDistroProbes = { ...distroProbes }
  const nextNovaclawChecks = { ...novaclawChecks }
  delete nextDistroProbes[distro]
  delete nextNovaclawChecks[distro]
  return { distroProbes: nextDistroProbes, novaclawChecks: nextNovaclawChecks }
}

export function wslTerminalArgs(distro?: string | null) {
  return ["/c", "start", "", "wsl", ...(distro ? ["-d", distro] : [])]
}

export function requireWslIpcString(name: string, value: unknown) {
  if (typeof value === "string" && value.length > 0) return value
  throw new Error(`Invalid ${name}`)
}
