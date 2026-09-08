/**
 * The small process-wide airgap state shared by the full HTTP guard and the maintenance-plane
 * crash seam. Keeping this leaf free of SQLite and Effect lets a Node desktop producer observe the
 * same live policy without importing the Bun-only database driver.
 */
export interface Policy {
  readonly enabled: boolean
  readonly allowedHosts: ReadonlySet<string>
}

export const disabledPolicy: Policy = { enabled: false, allowedHosts: new Set() }

let live: Policy | undefined
let builds = 0

export function publish(policy: Policy): void {
  live = policy
}

export function publishBuild(policy: Policy): void {
  builds++
  publish(policy)
}

export function currentPolicy(): Policy {
  return live ?? disabledPolicy
}

export function serviceBuilds(): number {
  return builds
}

export function resetPolicy(): void {
  live = undefined
}
