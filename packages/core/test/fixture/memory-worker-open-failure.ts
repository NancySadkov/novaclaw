import { appendFileSync, readFileSync } from "node:fs"
import { createInterface } from "node:readline"

appendFileSync(process.argv[2]!, `${process.pid}\n`)
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { id: number; method: string }
  const mode = process.argv[3] ? readFileSync(process.argv[3], "utf8") : "fail"
  if (request.method === "open" && mode === "hang") continue
  const response = request.method === "open" && mode === "fail"
    ? { id: request.id, ok: false, error: "graph initialization failed" }
    : { id: request.id, ok: true, value: { id: String(process.pid), opened: "fixture", skipped: [], quarantined: [] }, rssBytes: 100 }
  process.stdout.write(JSON.stringify(response) + "\n")
  if (request.method === "close") break
}
