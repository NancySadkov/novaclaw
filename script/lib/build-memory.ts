import { randomUUID } from "node:crypto"
import policy from "./build-memory.json"

export const BUILD_MEMORY_LIMIT_BYTES = policy.budgetMiB * 1024 ** 2
export const BUILD_NODE_HEAP_MB = policy.nodeHeapMiB
export const buildAllocationLimit = (budgetBytes: number) => Math.floor((budgetBytes * 3) / 4)
const JOB_ENV = "NOVACLAW_BUILD_MEMORY_JOB"
const LIMIT_FLAGS = 0x200 | 0x2000

export function buildEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    NODE_OPTIONS: `--max-old-space-size=${BUILD_NODE_HEAP_MB} --max-semi-space-size=${policy.nodeSemiSpaceMiB}`,
    GOMEMLIMIT: `${policy.goMemoryMiB}MiB`,
    GOMAXPROCS: "2",
    UV_THREADPOOL_SIZE: "2",
    CARGO_BUILD_JOBS: "1",
    RAYON_NUM_THREADS: "1",
  }
}

export async function buildMemoryBoundary(limitBytes = BUILD_MEMORY_LIMIT_BYTES) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0 || limitBytes > BUILD_MEMORY_LIMIT_BYTES)
    throw new Error("Build memory limit must be a positive integer no greater than 1280 MiB")
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("The desktop build memory boundary requires Windows x64")
  const { dlopen, ptr } = await import("bun:ffi")
  const library = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
    OpenJobObjectW: { args: ["u32", "i32", "ptr"], returns: "u64" },
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
  const inherited = process.env[JOB_ENV] !== undefined
  const jobName = process.env[JOB_ENV] ?? `Local\\NovaClaw.BuildMemory.${process.pid}.${randomUUID()}`
  const name = Buffer.from(`${jobName}\0`, "utf16le")
  const handle = checked(
    inherited ? api.OpenJobObjectW(0x0004, 0, ptr(name)) : api.CreateJobObjectW(null, ptr(name)),
    inherited ? "OpenJobObjectW" : "CreateJobObjectW",
  )
  const read = () => {
    const data = Buffer.alloc(144)
    checked(api.QueryInformationJobObject(handle, 9, ptr(data), data.length, null), "QueryInformationJobObject")
    return {
      limitBytes: Number(data.readBigUInt64LE(120)),
      peakBytes: Number(data.readBigUInt64LE(136)),
      flags: data.readUInt32LE(16),
    }
  }
  try {
    if (!inherited) {
      const data = Buffer.alloc(144)
      data.writeUInt32LE(LIMIT_FLAGS, 16)
      data.writeBigUInt64LE(BigInt(buildAllocationLimit(limitBytes)), 120)
      checked(api.SetInformationJobObject(handle, 9, ptr(data), data.length), "SetInformationJobObject")
      checked(api.AssignProcessToJobObject(handle, api.GetCurrentProcess()), "AssignProcessToJobObject")
    }
    const membership = Buffer.alloc(4)
    checked(api.IsProcessInJob(api.GetCurrentProcess(), handle, ptr(membership)), "IsProcessInJob")
    const actual = read()
    if (
      !membership.readUInt32LE(0) ||
      actual.limitBytes <= 0 ||
      actual.limitBytes > buildAllocationLimit(limitBytes) ||
      actual.flags !== LIMIT_FLAGS
    )
      throw new Error("The build process does not have the required aggregate memory boundary")
    process.env[JOB_ENV] = jobName
    if (inherited) {
      api.CloseHandle(handle)
      library.close()
    }
    return { inherited, read: inherited ? () => actual : read }
  } catch (error) {
    api.CloseHandle(handle)
    library.close()
    throw error
  }
}
