/**
 * Write the one message a refusal produces, in a way a hard exit cannot lose.
 *
 * ─── why this exists ────────────────────────────────────────────────────────────────────────────
 *
 * `script/test.ts`'s footer states the rule: *"`process.exitCode`, not `process.exit()`:
 * `process.exit()` truncates queued writes whenever stdout/stderr is a pipe or a file rather than a
 * TTY."* The refusal paths could not obey it — a memory refusal has to stop the run from where it
 * stands, and it must kill the pool on the way out — and they are the sites where the written text
 * **is** the entire output: which unit, how much commit vs resident was needed, who is holding it,
 * what still fits. A reader who loses that gets exit 2 and silence, which is indistinguishable from
 * a harness that was killed.
 *
 * ⚠️ **The stated damage does NOT reproduce on this runtime, and that is worth writing down rather
 * than repeating.** Measured 2026-09-02 under `bun` on Windows: 20 000 separate `process.stderr.write`
 * calls followed immediately by `process.exit(2)` arrive COMPLETE, to a file and through a pipe, up
 * to 80 MB in one write. Node's own documentation puts the asynchronous cases elsewhere again (a
 * Windows TTY; a POSIX pipe on macOS), i.e. not where the note said. So this module is not repairing
 * an observed loss.
 *
 * It exists because the hazard is real where the harness also runs — `BUILD-linux.md` is a supported
 * target, and a POSIX pipe is the documented asynchronous case — and because the cost of being
 * immune is one synchronous call. A diagnosis that only survives on the runtime somebody happened to
 * measure is not a diagnosis you can rely on at 3 a.m.
 *
 * 🔴 **The other half of `process.exit()` is not truncation at all — it is SKIPPED FINALIZERS**, and
 * that half was real and measured: the peak sampler's PowerShell loop outlived every refusal path in
 * the harness. Nothing here addresses that; the fix for it is that the sampler's loop bounds itself
 * (`peak-sampler.ts`). The two are one class — *a hard exit that bypasses what the normal path
 * owns* — and they close at different seams.
 */
import { writeSync } from "node:fs"

/** How many EAGAIN retries before giving up. A non-blocking pipe drains fast or not at all. */
const EAGAIN_RETRIES = 1000

/**
 * Write `text` to stderr synchronously, returning only once the bytes are with the OS.
 *
 * 🔴 **Never throws**, whatever the fd turns out to be. This is the last thing a refusal does before
 * it dies, so a diagnostic that could itself fail would replace a legible refusal with an
 * unhandled error — the exact outcome it exists to prevent. A closed pipe (EPIPE) is silence by the
 * reader's own choice; anything else falls back to the buffered stream, which is still better than
 * nothing.
 */
export function writeDiagnostic(text: string): void {
  const bytes = Buffer.from(text, "utf8")
  let offset = 0
  for (let attempt = 0; offset < bytes.length && attempt < EAGAIN_RETRIES; attempt++) {
    try {
      // A partial write is normal on a pipe, so the return value is the loop's cursor, never ignored.
      offset += writeSync(2, bytes, offset, bytes.length - offset)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // A non-blocking pipe with a full buffer. Retry: the reader is behind, not gone.
      if (code === "EAGAIN") continue
      // The reader closed. There is nobody to tell, and raising here would be noise about noise.
      if (code === "EPIPE") return
      try {
        process.stderr.write(bytes.subarray(offset))
      } catch {
        /* nothing left to try */
      }
      return
    }
  }
}
