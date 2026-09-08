// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// xdg-basedir reads env vars at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll } from "bun:test"

// Set XDG env vars FIRST, before any src/ imports
const DATA_PREFIX = "novaclaw-test-data-"
const dir = path.join(os.tmpdir(), DATA_PREFIX + process.pid)

/**
 * 🔴 **Reap abandoned data roots — the `afterAll` below is NOT a teardown mechanism on its own.**
 *
 * It runs on a normal finish and not when the process is killed or crashes, and the gate has been
 * killed mid-run repeatedly. This directory is the instance's whole XDG home (data, cache, config,
 * state, plus the test home and the managed-config dir), so an abandoned one is not just clutter:
 * it is a complete previous instance, and because Windows recycles PIDs a later run eventually
 * inherits it and starts against **another run's database**.
 *
 * That is not hypothetical. The identical shape one prefix over
 * (`os.tmpdir()/novaclaw-initiation-<pid>.db`) accumulated **257 files by 2026-08-06** and produced a
 * recurring gate failure that read as a content regression in messenger rather than as stale state;
 * **52 of these** had piled up alongside it. `packages/novaclaw/test/fixture/fixture.ts` already had
 * the right answer for its own roots — this is the same reap, for the directory that matters most.
 *
 * Keyed on PID liveness, never on age: units run in their own processes, so an age sweep would
 * delete a CONCURRENT run's home. `process.kill(pid, 0)` is the probe — no throw means alive,
 * `ESRCH` means gone, `EPERM` means alive under another account and is left alone.
 */
try {
  const fsSync = await import("node:fs")
  for (const entry of fsSync.readdirSync(os.tmpdir())) {
    if (!entry.startsWith(DATA_PREFIX)) continue
    const pid = Number(entry.slice(DATA_PREFIX.length))
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    try {
      process.kill(pid, 0)
      continue // still running — not ours to delete
    } catch (error) {
      if ((error as { code?: string } | undefined)?.code === "EPERM") continue
    }
    try {
      fsSync.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true })
    } catch {
      // Another process may be reaping the same root; losing the race is fine.
    }
  }
} catch {
  // A readdir failure must never stop the suite from starting.
}

await fs.mkdir(dir, { recursive: true })
afterAll(async () => {
  const { AppRuntime } = await import("../src/effect/app-runtime")
  await AppRuntime.dispose()

  const busy = (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY"
  const rm = async (left: number): Promise<void> => {
    Bun.gc(true)
    await sleep(100)
    return fs.rm(dir, { recursive: true, force: true }).catch((error) => {
      if (!busy(error)) throw error
      if (left <= 1 && process.platform !== "win32") throw error
      if (left <= 1) return
      return rm(left - 1)
    })
  }

  // Windows can keep SQLite WAL handles alive until GC finalizers run, so we
  // force GC and retry teardown to avoid flaky EBUSY in test cleanup.
  await rm(30)
})

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
process.env["NOVACLAW_MODELS_PATH"] = path.join(import.meta.dir, "tool", "fixtures", "models-api.json")
process.env["NOVACLAW_EXPERIMENTAL_EVENT_SYSTEM"] = "true"
process.env["NOVACLAW_EXPERIMENTAL_WORKSPACES"] = "true"

// Set test home directory to isolate tests from user's actual home directory
// This prevents tests from picking up real user configs/skills from ~/.claude/skills
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["NOVACLAW_TEST_HOME"] = testHome

// Set test managed config directory to isolate tests from system managed settings
const testManagedConfigDir = path.join(dir, "managed")
process.env["NOVACLAW_TEST_MANAGED_CONFIG_DIR"] = testManagedConfigDir

// Write the cache version file to prevent global/index.ts from clearing the cache
const cacheDir = path.join(dir, "cache", "novaclaw")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "14")

// Clear provider and server auth env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["AWS_REGION"]
delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["LLM_GATEWAY_API_KEY"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]
delete process.env["NOVACLAW_SERVER_PASSWORD"]
delete process.env["NOVACLAW_SERVER_USERNAME"]
delete process.env["NOVACLAW_EXPERIMENTAL"]
delete process.env["NOVACLAW_ENABLE_EXPERIMENTAL_MODELS"]

// Use in-memory sqlite
process.env["NOVACLAW_DB"] = ":memory:"
