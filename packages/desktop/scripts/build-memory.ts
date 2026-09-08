// What a desktop build actually costs, and the floor derived from it.
//
// This exists as its own module so the numbers can be READ and TESTED without importing
// `prebuild.ts`, which calls `enforce` at module scope: importing that to check a constant would run
// the guard and abort the test process.
//
// The two heaviest stages, measured on a 16 GB Windows machine, run SEQUENTIALLY — the Vite
// production build finishes and exits before electron-builder starts — so the demand is the LARGER
// of the two, never their sum.
export const VITE_PRODUCTION_PEAK_BYTES = 1.25 * 1024 ** 3
export const ELECTRON_BUILDER_PEAK_BYTES = 1.0 * 1024 ** 3

/** The heaviest single stage. Sequential stages do not add. */
export const MEASURED_PEAK_BYTES = Math.max(VITE_PRODUCTION_PEAK_BYTES, ELECTRON_BUILDER_PEAK_BYTES)

/**
 * Why an admission floor is above the peak at all: the guard's job is to refuse BEFORE Windows is
 * forced into sustained paging, not to refuse when the build would run out of memory. Those are
 * different lines, and the second one is useless — a thrashing build does not report as an OOM, it
 * reports as a hang, and this repository has twice written such a death off as "memory pressure"
 * and sent the same build back into the same wall.
 *
 * ⚠️ 40%, lowered from an implicit 100% on 2026-09-02. The floor was a hand-typed `2.5 GB` — almost
 * exactly twice the measured peak — and it began refusing ordinary builds on the machine it was
 * measured on: an editor, a browser and two assistant sessions leave free memory hovering at
 * 2.4-2.8 GB, so the same clean tree refused and then passed minutes later with nothing changed. A
 * guard that fires on a normal desktop is not protecting the build, it is training its operator to
 * retry until it stops complaining, which is the same as not having one.
 *
 * 0.5 GB of headroom over the heaviest stage is still real. If a build is ever OOM-killed or observed
 * paging above this floor, raise it and record the measurement here — do not raise it on a feeling.
 */
export const HEADROOM = 1.4

/** The admission floor: the heaviest stage plus headroom. Never a hand-typed round number. */
export const MINIMUM_FREE_BYTES = MEASURED_PEAK_BYTES * HEADROOM
