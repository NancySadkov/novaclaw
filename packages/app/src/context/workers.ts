import { createQuery } from "@/utils/query"
import { createMemo, type Accessor } from "solid-js"
import { useServerSDK } from "./server-sdk"
import { useServer } from "./server"
import { stableRows } from "@/utils/stable-rows"

/** What the worker row renders, and therefore what its identity may depend on. */
export interface LivingWorker {
  readonly id: string
  readonly title?: string
  readonly startedAt?: number
}

/**
 * The running workers below a chat, as rows that SURVIVE a poll.
 *
 * 🔴 **This is the boundary, and it is the only place the row's identity can be repaired.** The query
 * returns a new array of new objects every 2 s — `structuralSharing` is off in `@tanstack/solid-query`
 * (`useBaseQuery.ts`) — and `<For>` reuses a row only on reference equality, so handing its rows
 * straight through destroyed and recreated every row on every tick. `worker-list-dialog.tsx` puts the
 * stop-reason `<textarea autofocus>` inside a row, so the field the user was typing into was torn down
 * and re-autofocused underneath them, twice a second. Owner, 2026-09-27.
 *
 * ⚠️ `state` is dropped here rather than passed through, and that is the second half of the same
 * defect: it is on the wire and absent from the row, so under a whole-object identity it rebuilt the
 * row the moment a worker went `queued → busy`.
 *
 * ⚠️ **`workers` is the list, and nothing else reads `query.data`.** The button's badge and the
 * dialog's rows must agree about how many workers there are, and a count derived from the raw query
 * beside a list derived from the stable one is a disagreement waiting for the first poll where they
 * differ. `refetch` is here because stopping a worker is the one moment the user expects the row to
 * go, and the dialog's Stop button is not the place that knows how.
 */
export interface LivingWorkers {
  readonly workers: Accessor<readonly LivingWorker[]>
  readonly refetch: () => Promise<unknown>
}

export function useWorkers(sessionID: Accessor<string | undefined>): LivingWorkers {
  const sdk = useServerSDK()
  const server = useServer()
  const query = createQuery(() => ({
    queryKey: ["session-living-workers", server.key, sessionID()],
    enabled: sessionID() !== undefined,
    queryFn: async ({ signal }) => {
      const response = await sdk().client.v2.session.worker.list({ sessionID: sessionID()! }, { signal })
      return response.data?.data ?? []
    },
    refetchInterval: 2_000,
  }))
  const workers = createMemo(() =>
    stableRows<{ id: string; title?: string; state?: string; startedAt?: number }>(() => query.data, {
      key: (worker) => worker.id,
      fields: (worker) => ({ title: worker.title, startedAt: worker.startedAt }),
      project: (worker) => ({ id: worker.id, title: worker.title, startedAt: worker.startedAt }),
    })(),
  )
  return {
    workers,
    refetch: async () => {
      await query.refetch()
    },
  }
}
