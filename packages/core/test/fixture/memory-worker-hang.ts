import { createInterface } from "node:readline"

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id: number; method: string }
  if (request.method === "open") {
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, value: { opened: "fixture", skipped: [], quarantined: [] } }) + "\n")
  } else await new Promise(() => undefined)
}
