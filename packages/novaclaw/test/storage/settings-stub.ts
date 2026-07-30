import { Effect, Layer } from "effect"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"

/**
 * An in-memory stand-in for the SQLite settings store.
 *
 * Storage depends on it because `Storage.pressure()` reads its thresholds through to the store on
 * every call (todo.md ruling 3). Tests that do not care about thresholds still have to supply it, and
 * tests that DO care need to mutate it underneath a live service — which is the whole point of ruling
 * 3 and is exactly what a real SQLite store makes expensive to arrange.
 *
 * `state.current` is deliberately a mutable box rather than a captured value: the ruling-3 test changes
 * it between two calls on the SAME service instance, and a captured snapshot would make that test pass
 * for the wrong reason.
 */
export type SettingsState = { current: Record<string, unknown> }

export const settingsStub = (state: SettingsState = { current: {} }) =>
  Layer.succeed(
    SettingsConfigStore.Service,
    SettingsConfigStore.Service.of({
      all: () => Effect.sync(() => state.current),
      set: (key, value) => Effect.sync(() => void (state.current = { ...state.current, [key]: value })),
      remove: (key) =>
        Effect.sync(() => {
          const next = { ...state.current }
          delete next[key]
          state.current = next
        }),
      isEmpty: () => Effect.sync(() => Object.keys(state.current).length === 0),
    }),
  )
