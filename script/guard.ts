#!/usr/bin/env bun
/**
 * Run the heavy-job guard on its own, so a caller can refuse BEFORE doing damage.
 *
 * 🔴 **Why this exists.** The old release wrapper cleaned `dist` in step 0 and reached the guard
 * in step 1 (inside `prebuild.ts`). So a build the guard REFUSED still deleted the artifact that was
 * there — measured 2026-08-11: 2.4 GB free against a 2.5 GB floor, no new build, and the previous
 * 179 MB `.7z` gone. A guard whose stated purpose is to refuse *before* the machine is forced into
 * sustained paging should also refuse before destroying the thing it is protecting.
 *
 *   bun script/guard.ts "a desktop build" --min-free-gb 2.5
 *
 * Exits 0 when it is safe to proceed, 2 with the refusal on stderr otherwise — the same verdict
 * `prebuild.ts` enforces, from the same function, so the two can never disagree about what is safe.
 *
 * ⚠️ **Pass the caller's floor, or this is stricter than the job it guards.** The default is 6 GB;
 * a desktop build declares 2.5 GB, justified in `prebuild.ts` by measurement ("the production Vite
 * stage completes under a 1.25 GB V8 old-space cap and electron-builder stayed below 1 GB"). Running
 * this without `--min-free-gb` in front of that build would refuse runs that would have succeeded —
 * which is a worse failure than the one it fixes, because it is invisible: the build simply never
 * starts and the machine looks busy.
 */
/**
 * ⚠️ **RESTORED 2026-09-03, and the deletion is the lesson.** This was removed as dead code by the
 * refactor sweep (`cb25f0ccd`) because nothing in THIS repository calls it. Its only caller is
 * `build-release.bat`, which lives in the plan repository — a separate git repo the sweep
 * could not see. So the release path was broken from that commit until the next release was cut, and
 * it failed at step 0 with `Module not found`, having already been reported "done" by every ad-hoc
 * build in between because those bypassed the wrapper entirely.
 *
 * A grep for callers is only as wide as the tree it runs in. Before deleting an entry point, check
 * the sibling repo — `git -C .. grep <name>` is the whole check.
 */
import { enforce } from "./lib/heavy-guard"

const flag = process.argv.indexOf("--min-free-gb")
const gb = flag >= 0 ? Number(process.argv[flag + 1]) : undefined
if (flag >= 0 && !Number.isFinite(gb)) {
  console.error("--min-free-gb needs a number of gigabytes")
  process.exit(2)
}

enforce(
  process.argv[2] ?? "this job",
  process.argv,
  gb === undefined ? {} : { minimumFreeBytes: gb * 1024 ** 3 },
)
