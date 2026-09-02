import type { ServerConnection } from "@/context/server"
import { type InstanceSend, instanceFetchResponse } from "./instance-fetch"

export const MAX_INSTANCE_DIAGNOSTIC_BYTES = 2 * 1024 * 1024
export const DIAGNOSTIC_TIMEOUT_MS = 10_000
export async function fetchInstanceDiagnostics(
  server: ServerConnection.HttpBase,
  options: {
    readonly fetch?: InstanceSend
    readonly signal?: AbortSignal
    readonly timeoutMs?: number
    readonly maxBytes?: number
  } = {},
): Promise<string> {
  return instanceFetchResponse(
    server,
    {
      method: "POST",
      route: "api/log/export",
      headers: { accept: "text/plain" },
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DIAGNOSTIC_TIMEOUT_MS,
      fetch: options.fetch,
    },
    async (response) => {
      const limit = options.maxBytes ?? MAX_INSTANCE_DIAGNOSTIC_BYTES
      const reader = response.body?.getReader()
      // A 2xx that promised diagnostics and sent none. Returning "" writes a debug-log file whose
      // instance section is empty and reports success. The one caller already degrades to
      // "exporting desktop records only" on a throw, which is the honest outcome.
      if (!reader) throw new Error("The instance answered the diagnostics export with an empty body")
      const decoder = new TextDecoder()
      let total = 0
      let text = ""
      while (true) {
        const next = await reader.read()
        if (next.done) break
        total += next.value.byteLength
        if (total > limit) {
          await reader.cancel("diagnostic response exceeded its byte budget")
          throw new Error(`Instance diagnostics exceeded the ${limit}-byte response budget`)
        }
        text += decoder.decode(next.value, { stream: true })
      }
      return text + decoder.decode()
    },
  )
}
