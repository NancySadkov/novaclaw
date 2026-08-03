import type { RootLoadArgs } from "./types"
import { withRequestDeadline } from "@/utils/request-deadline"

export async function loadRootSessionsWithFallback(input: RootLoadArgs) {
  const list = (query: { directory: string; roots: true; limit?: number }) =>
    withRequestDeadline({
      label: "Loading sessions",
      timeoutMs: input.timeoutMs,
      run: (signal) => input.list(query, { signal }),
    })
  try {
    const result = await list({ directory: input.directory, roots: true, limit: input.limit })
    return {
      data: result.data,
      limit: input.limit,
      limited: true,
    } as const
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw error
    const result = await list({ directory: input.directory, roots: true })
    return {
      data: result.data,
      limit: input.limit,
      limited: false,
    } as const
  }
}

export function estimateRootSessionTotal(input: { count: number; limit: number; limited: boolean }) {
  if (!input.limited) return input.count
  if (input.count < input.limit) return input.count
  return input.count + 1
}
