import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"

const directory = await mkdtemp(join(tmpdir(), "novaclaw-memory-worker-smoke-"))
const child = spawn(process.execPath, [resolve(process.argv[2])], { stdio: ["pipe", "pipe", "inherit"] })
const pending = new Map()
let id = 0
const deadline = setTimeout(() => {
  child.kill()
  console.error("Node memory worker smoke timed out")
  process.exit(3)
}, 30_000)
const fail = (reason) => {
  for (const entry of pending.values()) entry.reject(new Error(reason))
  pending.clear()
}
child.on("error", (error) => fail(error.message))
child.on("exit", (code) => fail(`memory worker exited (${code})`))
createInterface({ input: child.stdout }).on("line", (line) => {
  const reply = JSON.parse(line)
  const entry = pending.get(reply.id)
  if (!entry) return
  pending.delete(reply.id)
  if (reply.ok) entry.resolve(reply.value)
  else entry.reject(new Error(reply.error))
})
const request = (method, ...args) => new Promise((resolve, reject) => {
  const next = ++id
  pending.set(next, { resolve, reject })
  child.stdin.write(JSON.stringify({ id: next, method, args }) + "\n")
})

try {
  await request("open", join(directory, "graph"), { dim: 8 })
  await request("addMemory", { id: "smoke", kind: "episode", text: "worker is alive", scope: "global" })
  const memory = await request("get", "smoke", {})
  if (memory?.text !== "worker is alive") throw new Error("memory worker did not return its stored memory")
  const candidates = await request("candidates", { scopes: ["global"], limit: 1, offset: 0 })
  if (candidates?.[0]?.id !== "smoke") throw new Error("memory worker could not page candidates")
  await request("close")
  console.log("Node memory worker smoke passed")
} finally {
  clearTimeout(deadline)
  child.kill()
  await rm(directory, { recursive: true, force: true })
}
