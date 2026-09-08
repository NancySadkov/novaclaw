// ui-arch-hardening P3 — the one-view-host invariant, made observable. Session views mount
// through the router ONLY; every live PromptInput registers here so a second steady-state
// instance for the same session is caught the moment a stray mounter creeps back in (the
// 2026-07-14 autofocus incident observed two composers for one session), not three bug
// reports later. A router transition briefly holds the outgoing and incoming view alive
// while swapping, so duplicates are re-checked after a beat instead of flagged immediately.

type Schedule = (check: () => void) => void

export function createComposerMountRegistry(input?: { warn?: (message: string) => void; schedule?: Schedule }) {
  const warn = input?.warn ?? ((message: string) => console.warn(message))
  const schedule = input?.schedule ?? ((check) => void setTimeout(check, 120))
  const counts = new Map<string, number>()

  return {
    register(key: string) {
      const next = (counts.get(key) ?? 0) + 1
      counts.set(key, next)
      if (next > 1)
        schedule(() => {
          const live = counts.get(key) ?? 0
          if (live > 1)
            warn(
              `[composer] ${live} PromptInput instances live for "${key}" — session views must mount through the router only (ui-arch P3)`,
            )
        })
      let released = false
      return () => {
        if (released) return
        released = true
        const current = counts.get(key) ?? 0
        if (current <= 1) counts.delete(key)
        else counts.set(key, current - 1)
      }
    },
    count(key: string) {
      return counts.get(key) ?? 0
    },
    snapshot() {
      return Object.fromEntries(counts)
    },
  }
}

export const composerMounts = createComposerMountRegistry()

declare global {
  interface Window {
    __novaComposerMounts?: () => Record<string, number>
  }
}

// Probe for dev tooling and preview-driven gates: window.__novaComposerMounts() → { key: count }.
if (typeof window !== "undefined") window.__novaComposerMounts = () => composerMounts.snapshot()
