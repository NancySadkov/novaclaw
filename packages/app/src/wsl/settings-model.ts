import type { WslNovaclawCheck, WslServerRuntime } from "./types"

export const wslRuntimeRetryable = (runtime: WslServerRuntime) =>
  runtime.kind === "failed" || runtime.kind === "stopped"

export async function enterWslNovaclawStep(
  distro: string,
  probe: (distro: string) => Promise<unknown>,
  select: (step: "novaclaw") => void,
) {
  await probe(distro)
  select("novaclaw")
}

export function wslNovaclawAction(check?: WslNovaclawCheck) {
  if (!check) return
  if (!check.resolvedPath) return "Install NovaClaw"
  if (check.matchesDesktop === false) return "Update NovaClaw"
}
