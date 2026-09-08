/**
 * Which write is allowed to say "saved".
 *
 * 🔴 **NC-REL-038 — an older autosave cleared a newer edit's dirty bit.** Every keystroke set one
 * page-global `dirty` and armed the debounce; every successful write then called `setDirty(false)`
 * unconditionally, without asking whether the editor had changed since that write captured its
 * content. So typing while a save was in flight ended with `dirty === false` over text that had never
 * been written — and navigation, which flushes only when dirty, discarded it.
 *
 * The write is not wrong to finish; it is wrong to speak for the editor's CURRENT state. A revision
 * counter is the whole fix: the save that began at revision N may only clear the flag if the editor
 * is still at revision N.
 *
 * ⚠️ Its own module because the race is the thing worth testing, and it is otherwise buried in a
 * component that needs a server, a directory and a live filesystem to mount. What is here is the
 * decision; `notes.tsx` supplies the timer and the write.
 */
export type Autosave = {
  /** The editor changed. Any write already in flight no longer speaks for it. */
  readonly edited: () => void
  /** A write is starting now, carrying everything edited so far. */
  readonly begin: () => void
  /** May the write that just finished clear the dirty flag? */
  readonly settles: () => boolean
}

export function createAutosave(): Autosave {
  let revision = 0
  let inFlight = 0
  return {
    edited: () => {
      revision++
    },
    begin: () => {
      inFlight = revision
    },
    settles: () => inFlight === revision,
  }
}
