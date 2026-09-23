import { existsSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"

const marker = process.argv[2]!
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id: number; method: string }
  if (request.method === "get" && !existsSync(marker)) {
    writeFileSync(marker, "crashed")
    process.exit(19)
  }
  const value = request.method === "open"
    ? { opened: "fixture", skipped: [], quarantined: [] }
    : request.method === "get"
      ? { id: "recovered", text: "the worker recovered" }
      : undefined
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, value }) + "\n")
  if (request.method === "close") break
}
