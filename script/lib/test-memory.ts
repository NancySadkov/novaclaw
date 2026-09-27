import { readFileSync } from "node:fs"
import { posix } from "node:path"

export const TEST_MEMORY_LIMIT_BYTES = 8 * 1024 ** 3
export const TEST_MEMORY_ALLOCATION_BYTES = 7 * 1024 ** 3

export const allocationLimit = (budgetBytes: number) => Math.floor((testMemoryLimit(budgetBytes) * 7) / 8)

export function boundedTestHeadroom<T extends { commitBytes: number }>(headroom: T): T {
  return { ...headroom, commitBytes: Math.min(headroom.commitBytes, TEST_MEMORY_ALLOCATION_BYTES) }
}

export function testMemoryLimit(requested = TEST_MEMORY_LIMIT_BYTES): number {
  if (!Number.isSafeInteger(requested) || requested <= 0 || requested > TEST_MEMORY_LIMIT_BYTES)
    throw new Error("Test memory limit must be a positive integer no greater than 8 GiB")
  return requested
}

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const JOB_OBJECT_BREAKAWAY_FLAGS = 0x1800
const EXTENDED_LIMIT_SIZE = 144
const LIMIT_FLAGS_OFFSET = 16
const JOB_MEMORY_LIMIT_OFFSET = 120
const PEAK_JOB_MEMORY_OFFSET = 136
const SHARED_JOB_NAME = "Local\\NovaClaw.TestMemory.v1"

export async function windowsTestMemory(limitBytes = TEST_MEMORY_LIMIT_BYTES) {
  testMemoryLimit(limitBytes)
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("The Windows test memory boundary requires Windows x64")
  const { dlopen, ptr } = await import("bun:ffi")
  const library = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
    GetCurrentProcess: { args: [], returns: "u64" },
    GetLastError: { args: [], returns: "u32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    IsProcessInJob: { args: ["u64", "u64", "ptr"], returns: "i32" },
    SetInformationJobObject: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    QueryInformationJobObject: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" },
  })
  const api = library.symbols
  const checked = (result: number | bigint, operation: string) => {
    if (!result) throw new Error(`${operation} failed (Windows error ${api.GetLastError()})`)
    return result
  }
  const query = (handle: number | bigint) => {
    const data = Buffer.alloc(EXTENDED_LIMIT_SIZE)
    checked(
      api.QueryInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ptr(data), data.length, null),
      "QueryInformationJobObject",
    )
    return {
      limitBytes: Number(data.readBigUInt64LE(JOB_MEMORY_LIMIT_OFFSET)),
      peakBytes: Number(data.readBigUInt64LE(PEAK_JOB_MEMORY_OFFSET)),
      flags: data.readUInt32LE(LIMIT_FLAGS_OFFSET),
    }
  }
  const configure = (handle: number | bigint, bytes: number, flags: number) => {
    const data = Buffer.alloc(EXTENDED_LIMIT_SIZE)
    data.writeUInt32LE(flags, LIMIT_FLAGS_OFFSET)
    data.writeBigUInt64LE(BigInt(bytes), JOB_MEMORY_LIMIT_OFFSET)
    checked(
      api.SetInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ptr(data), data.length),
      "SetInformationJobObject",
    )
    const actual = query(handle)
    if (actual.limitBytes !== bytes || actual.flags !== flags)
      throw new Error("Windows did not retain the required test memory limits")
  }
  const current = api.GetCurrentProcess()
  const name = Buffer.from(`${SHARED_JOB_NAME}\0`, "utf16le")
  const shared = checked(api.CreateJobObjectW(null, ptr(name)), "CreateJobObjectW")
  let lifetime: number | bigint = 0
  try {
    const membership = Buffer.alloc(4)
    checked(api.IsProcessInJob(current, shared, ptr(membership)), "IsProcessInJob")
    const inherited = membership.readInt32LE(0) !== 0
    if (!inherited) {
      configure(shared, TEST_MEMORY_ALLOCATION_BYTES, JOB_OBJECT_LIMIT_JOB_MEMORY)
      checked(api.AssignProcessToJobObject(shared, current), "AssignProcessToJobObject(shared)")
    }
    const actual = query(shared)
    if (
      actual.limitBytes !== TEST_MEMORY_ALLOCATION_BYTES ||
      !(actual.flags & JOB_OBJECT_LIMIT_JOB_MEMORY) ||
      actual.flags & JOB_OBJECT_BREAKAWAY_FLAGS
    )
      throw new Error("The inherited test job does not enforce the shared 8 GiB ceiling")
    if (!inherited || limitBytes < TEST_MEMORY_LIMIT_BYTES) {
      lifetime = checked(api.CreateJobObjectW(null, null), "CreateJobObjectW(lifetime)")
      configure(lifetime, allocationLimit(limitBytes), JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
      checked(api.AssignProcessToJobObject(lifetime, current), "AssignProcessToJobObject(lifetime)")
    }
    return {
      inherited,
      read: () => query(lifetime || shared),
      shared: () => query(shared),
    }
  } catch (error) {
    if (lifetime) api.CloseHandle(lifetime)
    api.CloseHandle(shared)
    library.close()
    throw error
  }
}

export function linuxTestMemory(read: (path: string) => string = (path) => readFileSync(path, "utf8")): void {
  const membership = read("/proc/self/cgroup")
    .split("\n")
    .find((line) => line.startsWith("0::/"))
  if (!membership) throw new Error("Tests require a cgroup v2 memory boundary on Linux")
  const root = "/sys/fs/cgroup"
  let directory = posix.resolve(root, `.${membership.slice(3)}`)
  if (directory !== root && !directory.startsWith(`${root}/`)) throw new Error("Invalid cgroup membership")
  let memoryBounded = false
  let swapDisabled = false
  for (;;) {
    const memory = Number(read(posix.join(directory, "memory.max")).trim())
    memoryBounded ||= Number.isSafeInteger(memory) && memory > 0 && memory <= TEST_MEMORY_ALLOCATION_BYTES
    swapDisabled ||= read(posix.join(directory, "memory.swap.max")).trim() === "0"
    if (memoryBounded && swapDisabled) return
    if (directory === root) break
    directory = posix.resolve(directory, "..")
  }
  throw new Error("Tests require a cgroup v2 memory.max of at most 7 GiB and memory.swap.max of 0 (8 GiB budget)")
}

let boundary: Awaited<ReturnType<typeof windowsTestMemory>> | true | undefined

export async function enforceTestMemoryBoundary(): Promise<void> {
  if (boundary) return
  try {
    if (process.platform === "win32") boundary = await windowsTestMemory()
    else if (process.platform === "linux") {
      linuxTestMemory()
      boundary = true
    } else throw new Error(`No kernel-enforced test memory boundary is available for ${process.platform}`)
  } catch (error) {
    throw new Error(
      `Refusing to run tests without the 8 GiB memory boundary: ${error instanceof Error ? error.message : error}`,
    )
  }
}
