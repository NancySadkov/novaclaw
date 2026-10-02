export * as InstanceJob from "./instance-job"

/**
 * **OS-level containment for everything this instance spawns.**
 *
 * Cooperative teardown (`util/kill-tree.ts`) can only reach what a pid snapshot or `taskkill /t`
 * sees at the moment it runs. It cannot reach a process that re-parented, and it cannot run at all
 * after a hard kill — on Windows a server stop is `TerminateProcess`, so no `exit` hook survives.
 * The only guarantee that holds through *every* way the server can end is the kernel's own: a Job
 * Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, adopted by the server and inherited by every
 * child, worker and shell it ever launches. When the last handle to that job closes — including when
 * the server is killed outright — Windows terminates the entire job.
 *
 * ⚠️ **A Job Object does NOT own an OS *registration*.** A Windows scheduled task is not a child of
 * the server; its process is spawned later by the Task Scheduler service (`svchost`). This module
 * cannot reap that. The command gate refuses the registrations outright; see `HostExec`.
 *
 * ⚠️ **The handle is deliberately never closed.** Closing the last handle to a `KILL_ON_JOB_CLOSE`
 * job terminates every process in it, this one included. `retained` exists to keep it alive.
 *
 * Windows-only and best-effort by construction: on any host where the job cannot be created or the
 * process cannot join one (pre-Windows-8 nesting rules), `adopt()` answers `"degraded"` and the
 * server keeps running on cooperative teardown alone. It never throws — a containment fault must not
 * be the reason an instance refuses to start.
 */

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
/** `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` is 144 bytes; `LimitFlags` is the DWORD at offset 16. */
const EXTENDED_LIMIT_SIZE = 144
const LIMIT_FLAGS_OFFSET = 16

export type Status = "adopted" | "unavailable" | "degraded"

let status: Status | undefined
/** Kept for the life of the process — see the header. Never close this. */
let retained: unknown

/** The last answer {@link adopt} gave, or `undefined` if it has not run. */
export function current(): Status | undefined {
  return status
}

/**
 * Adopt the current process into a kill-on-close Job Object, so every process it spawns — now and
 * for the rest of its life — is reaped by Windows when this process ends, however it ends.
 *
 * Idempotent. Returns the containment status; never throws.
 */
export async function adopt(): Promise<Status> {
  if (status !== undefined) return status
  if (process.platform !== "win32" || typeof Bun === "undefined") {
    status = "unavailable"
    return status
  }
  try {
    const { dlopen, ptr } = await import("bun:ffi")
    const library = dlopen("kernel32.dll", {
      CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
      GetCurrentProcess: { args: [], returns: "u64" },
      CloseHandle: { args: ["u64"], returns: "i32" },
      SetInformationJobObject: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
      QueryInformationJobObject: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
      AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" },
    })
    const api = library.symbols

    const job = api.CreateJobObjectW(null, null)
    if (!job) {
      status = "degraded"
      return status
    }

    const limits = Buffer.alloc(EXTENDED_LIMIT_SIZE)
    limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET)
    const configured = api.SetInformationJobObject(
      job,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
      ptr(limits),
      limits.length,
    )
    if (!configured) {
      // Not yet a member of the job, so closing is safe and avoids leaking the handle.
      api.CloseHandle(job)
      status = "degraded"
      return status
    }

    const joined = api.AssignProcessToJobObject(job, api.GetCurrentProcess())
    if (!joined) {
      // ⚠️ Do NOT close after this point on success — but here the assign FAILED, so we are not in
      // the job and closing it is safe.
      api.CloseHandle(job)
      status = "degraded"
      return status
    }

    const actual = Buffer.alloc(EXTENDED_LIMIT_SIZE)
    const queried = api.QueryInformationJobObject(
      job,
      JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
      ptr(actual),
      actual.length,
      null,
    )
    if (!queried || !(actual.readUInt32LE(LIMIT_FLAGS_OFFSET) & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)) {
      // We ARE in the job now; closing the handle here would kill us. Leave it open and degrade.
      retained = { job, library }
      status = "degraded"
      return status
    }

    retained = { job, library }
    status = "adopted"
    return status
  } catch {
    status = "degraded"
    return status
  }
}
