const encoder = new TextEncoder()
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
let heartbeatID = 0

function frame(event: unknown) {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
}

function broadcast(event: unknown) {
  const body = frame(event)
  for (const client of clients) {
    try {
      client.enqueue(body)
    } catch {
      clients.delete(client)
    }
  }
}

export async function emitMockEvent(event: unknown) {
  const host = process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"
  const port = process.env.PLAYWRIGHT_SERVER_PORT ?? "4196"
  const response = await fetch(`http://${host}:${port}/__e2e/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  })
  if (!response.ok) throw new Error(`Mock event server answered ${response.status}`)
}

function startMockEventServer() {
  const portIndex = process.argv.indexOf("--port")
  const port = Number(portIndex === -1 ? 4196 : process.argv[portIndex + 1])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid --port: ${port}`)

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 255,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === "/global/health") return Response.json({ healthy: true })
      if (path === "/__e2e/event" && request.method === "POST") {
        broadcast(await request.json())
        return Response.json({ delivered: clients.size })
      }
      if (path !== "/global/event" && path !== "/event") return new Response("Not found", { status: 404 })

      let client: ReadableStreamDefaultController<Uint8Array> | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          client = controller
          clients.add(controller)
          controller.enqueue(frame({ payload: { id: "evt_mock_connected", type: "server.connected", properties: {} } }))
          request.signal.addEventListener(
            "abort",
            () => {
              clients.delete(controller)
              try {
                controller.close()
              } catch {}
            },
            { once: true },
          )
        },
        cancel() {
          if (client) clients.delete(client)
        },
      })
      return new Response(body, {
        headers: {
          "access-control-allow-origin": "*",
          "cache-control": "no-cache",
          "content-type": "text/event-stream",
        },
      })
    },
  })

  setInterval(
    () =>
      broadcast({ payload: { id: `evt_mock_heartbeat_${++heartbeatID}`, type: "server.heartbeat", properties: {} } }),
    5_000,
  )

  console.log(`Mock event server listening on ${server.hostname}:${server.port}`)
}

if (import.meta.main) startMockEventServer()
