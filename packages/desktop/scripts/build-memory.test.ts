import { describe, expect, test } from "bun:test"
import {
  ELECTRON_BUILDER_PEAK_BYTES,
  HEADROOM,
  MEASURED_PEAK_BYTES,
  MINIMUM_FREE_BYTES,
  VITE_PRODUCTION_PEAK_BYTES,
} from "./build-memory"

const GB = 1024 ** 3

// The floor is a DERIVED number, and this is what keeps it derived.
//
// It was a hand-typed `2.5 * 1024 ** 3` at the call site with its measurement in a comment above it,
// which is how a threshold and its justification drift apart. The failure that surfaced was not a
// crash: on the very machine the peak was measured on, ordinary builds began refusing at 2.4-2.8 GB
// free, so the same clean tree refused and then passed minutes later with nothing changed. A guard
// that fires on a normal desktop teaches its operator to retry until it stops complaining.
describe("the desktop build's admission floor", () => {
  test("clears the heaviest stage, because a floor under the peak admits a build that cannot finish", () => {
    expect(MINIMUM_FREE_BYTES).toBeGreaterThan(MEASURED_PEAK_BYTES)
  })

  test("the peak is the LARGER stage, never the sum — Vite exits before electron-builder starts", () => {
    expect(MEASURED_PEAK_BYTES).toBe(Math.max(VITE_PRODUCTION_PEAK_BYTES, ELECTRON_BUILDER_PEAK_BYTES))
    expect(MEASURED_PEAK_BYTES).toBeLessThan(VITE_PRODUCTION_PEAK_BYTES + ELECTRON_BUILDER_PEAK_BYTES)
  })

  test("keeps real headroom, so this is a paging guard and not an out-of-memory guard", () => {
    // Half a gigabyte over the heaviest stage. Stated as bytes rather than as the ratio, so a change
    // to HEADROOM that happens to keep the ratio while dropping the absolute margin still fails.
    expect(MINIMUM_FREE_BYTES - MEASURED_PEAK_BYTES).toBeGreaterThanOrEqual(0.4 * GB)
    expect(HEADROOM).toBeGreaterThan(1)
  })

  test("🔴 stays low enough to admit a build on a working desktop", () => {
    // The regression this file exists for. 2 GB free is an ordinary state on a 16 GB machine running
    // an editor, a browser and an assistant session; a floor above it refuses work that would have
    // succeeded. If a future measurement genuinely requires more than this, the peak above must move
    // first and this bound with it — the number may not be raised on its own.
    expect(MINIMUM_FREE_BYTES).toBeLessThanOrEqual(2 * GB)
  })
})
