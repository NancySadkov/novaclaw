import { TEST_MEMORY_LIMIT_BYTES } from "./test-memory"

export const KILL_FACTOR = 2
export const MIN_KILL_CAP_MB = 4096
export const MACHINE_ALLOWANCE_MB = TEST_MEMORY_LIMIT_BYTES / 1024 ** 2
export const MAX_KILL_CAP_FRACTION_OF_COMMIT = 0.625

export function unitCapMb(input: { profilePeakMb?: number; commitLimitMb?: number; requestedCapMb?: number }): number {
  const positive = (value: number | undefined): value is number =>
    value !== undefined && Number.isFinite(value) && value > 0
  const anchor = positive(input.profilePeakMb)
    ? Math.max(KILL_FACTOR * input.profilePeakMb, MIN_KILL_CAP_MB)
    : MACHINE_ALLOWANCE_MB
  const box = positive(input.commitLimitMb)
    ? MAX_KILL_CAP_FRACTION_OF_COMMIT * input.commitLimitMb
    : MACHINE_ALLOWANCE_MB
  const requested = positive(input.requestedCapMb) ? input.requestedCapMb : MACHINE_ALLOWANCE_MB
  return Math.max(1, Math.floor(Math.min(anchor, box, requested, MACHINE_ALLOWANCE_MB)))
}
