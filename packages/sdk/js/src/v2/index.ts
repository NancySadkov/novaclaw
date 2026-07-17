export * from "./client.js"
export * from "./server.js"

import { createNovaclawClient } from "./client.js"
import { createNovaclawServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createNovaclaw(options?: ServerOptions) {
  const server = await createNovaclawServer({
    ...options,
  })

  const client = createNovaclawClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
