import { createQuery } from "@tanstack/solid-query"
import type { Accessor } from "solid-js"
import { useServerSDK } from "./server-sdk"
import { useServer } from "./server"

export function useWorkers(sessionID: Accessor<string | undefined>) {
  const sdk = useServerSDK()
  const server = useServer()
  return createQuery(() => ({
    queryKey: ["session-living-workers", server.key, sessionID()],
    enabled: sessionID() !== undefined,
    queryFn: async () => {
      const response = await sdk().client.v2.session.worker.list({ sessionID: sessionID()! })
      return response.data?.data ?? []
    },
    refetchInterval: 2_000,
  }))
}
