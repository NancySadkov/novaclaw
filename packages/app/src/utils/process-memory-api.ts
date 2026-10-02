import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "@/utils/instance-fetch"

// `GET /api/memory-layout` — the Debug app's Memory tab. Per-process memory for the instance server
// and its live session workers, plus the server runtime's own heap breakdown.
//
// ⚠️ This is PROCESS memory, not the RAG `memory-api.ts` graph memory. The two are different facts and
// deliberately have different clients.
//
// 🔴 The server's OWN reading and its runtime breakdown travel together on purpose. `memoryUsage().rss`
// is self-reported and can understate a process by more than 30× against the host's commit charge, so
// a panel that showed only one of the two would be a confident falsehood about where memory went.
//
// ⚠️ `bytes: null` means UNKNOWN, never zero — the pid exited between listing and sampling, or the
// platform does not measure it. The panel prints that distinction rather than a fake `0 B`.

/** The host reading, mirroring `MemoryReading`: an unknown is its own answer, not a zero. */
export type HostMemory =
  | {
      readonly known: true
      readonly source: string
      readonly crosscheck: string
      readonly usedBytes: number
      readonly limitBytes: number
    }
  | { readonly known: false; readonly reason: string }

export interface ProcessMemoryRow {
  readonly pid: number
  readonly role: string
  /** A chat a person can open (a session id), or the role's own name. */
  readonly label: string
  readonly startedAt: number | null
  /** Commit on Windows, RSS on Linux — see `metric`. Null when the process could not be measured. */
  readonly bytes: number | null
}

export interface ProcessMemoryLayout {
  readonly measuredAt: number
  readonly metric: string
  readonly host: HostMemory
  readonly server: {
    readonly pid: number
    readonly rssBytes: number
    readonly heapTotalBytes: number
    readonly heapUsedBytes: number
    readonly externalBytes: number
    readonly arrayBuffersBytes: number
    readonly bytes: number | null
  }
  readonly processes: readonly ProcessMemoryRow[]
  readonly note: string
}

export function processMemory(server: ServerConnection.HttpBase) {
  return instanceFetch<ProcessMemoryLayout>(server, { route: "api/memory-layout" })
}
