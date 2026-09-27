import { windowsTestMemory } from "../test-memory"
import { dlopen, ptr } from "bun:ffi"

const MB = 1024 ** 2
const mode = process.argv[2]
const api = dlopen("kernel32.dll", {
  VirtualAlloc: { args: ["ptr", "u64", "u32", "u32"], returns: "ptr" },
  VirtualFree: { args: ["ptr", "u64", "u32"], returns: "i32" },
  QueryInformationJobObject: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
}).symbols

if (mode === "limits") {
  const boundary = await windowsTestMemory()
  console.log(JSON.stringify({ own: boundary.read(), shared: boundary.shared(), inherited: boundary.inherited }))
} else if (mode === "allocate-child") {
  const allocations = []
  for (let i = 0; i < 64; i++) {
    const allocation = api.VirtualAlloc(null, 16 * MB, 0x3000, 4)
    if (!allocation) break
    allocations.push(allocation)
  }
  const data = Buffer.alloc(144)
  if (!api.QueryInformationJobObject(0, 9, ptr(data), data.length, null)) throw new Error("Cannot query inherited job")
  console.log(
    JSON.stringify({
      allocatedBytes: allocations.length * 16 * MB,
      limitBytes: Number(data.readBigUInt64LE(120)),
      peakBytes: Number(data.readBigUInt64LE(136)),
      denied: allocations.length < 64,
    }),
  )
  for (const allocation of allocations) api.VirtualFree(allocation, 0, 0x8000)
} else if (mode === "aggregate") {
  const boundary = await windowsTestMemory(768 * MB)
  const held = api.VirtualAlloc(null, 96 * MB, 0x3000, 4)
  if (!held) throw new Error("Parent allocation failed before the probe")
  const child = Bun.spawn([process.execPath, import.meta.path, "allocate-child"], {
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exit !== 0) throw new Error(`Allocation child failed: ${exit}: ${stderr}`)
  console.log(JSON.stringify({ child: JSON.parse(stdout), parentHeld: 96 * MB, own: boundary.read() }))
  api.VirtualFree(held, 0, 0x8000)
} else if (mode === "orphan") {
  await windowsTestMemory(768 * MB)
  const node = Bun.which("node")
  if (!node) throw new Error("Node is required for the non-Bun descendant cleanup probe")
  const child = Bun.spawn([node, "-e", "console.log(process.pid); setInterval(() => {}, 1000)"], {
    stdout: "pipe",
    stderr: "ignore",
    windowsHide: true,
  })
  const reader = child.stdout.getReader()
  const ready = await reader.read()
  reader.releaseLock()
  process.stdout.write(ready.value!)
  setInterval(() => {}, 1000)
} else if (mode === "invalid") {
  await windowsTestMemory(9 * 1024 ** 3)
  console.log("UNSAFE WORK STARTED")
} else throw new Error(`Unknown probe ${mode}`)
