import { buildEnvironment, buildMemoryBoundary } from "../build-memory"
import { dlopen } from "bun:ffi"

const MB = 1024 ** 2
const api = dlopen("kernel32.dll", {
  VirtualAlloc: { args: ["ptr", "u64", "u32", "u32"], returns: "ptr" },
  VirtualFree: { args: ["ptr", "u64", "u32"], returns: "i32" },
}).symbols
if (process.argv[2] === "allocate") {
  const boundary = await buildMemoryBoundary()
  const allocations = []
  for (let i = 0; i < 64; i++) {
    const allocation = api.VirtualAlloc(null, 16 * MB, 0x3000, 4)
    if (!allocation) break
    allocations.push(allocation)
  }
  for (const allocation of allocations) api.VirtualFree(allocation, 0, 0x8000)
  const result = { denied: allocations.length < 64, allocatedBytes: allocations.length * 16 * MB, ...boundary.read() }
  console.log(JSON.stringify(result))
} else {
  const boundary = await buildMemoryBoundary(1024 * MB)
  const held = api.VirtualAlloc(null, 96 * MB, 0x3000, 4)
  if (!held) throw new Error("Parent allocation failed")
  const child = Bun.spawn([process.execPath, "--smol", import.meta.path, "allocate"], {
    env: buildEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`Child failed: ${exitCode}: ${stderr}`)
  console.log(JSON.stringify({ child: JSON.parse(stdout), parentHeldBytes: 96 * MB, ...boundary.read() }))
  api.VirtualFree(held, 0, 0x8000)
}
