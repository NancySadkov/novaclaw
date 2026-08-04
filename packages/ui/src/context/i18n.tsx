import { createContext, useContext, type Accessor, type ParentProps } from "solid-js"
import { dict as en } from "../i18n/en"

/**
 * Keys this UI layer renders that the HOST dictionary owns, not `packages/ui/src/i18n`.
 *
 * ⚠️ **This exists because the type used to under-declare the value it is actually given.**
 * `packages/app/src/app.tsx`'s `UiI18nBridge` passes the app's FULL translator into
 * `I18nProvider` — every one of the ~1900 keys in `packages/app/src/i18n/en.ts` plus this
 * package's own bundle. `UiI18nKey` said `keyof typeof en`, so a `packages/session-ui` component
 * could not typecheck a host key even though the translator it holds resolves it at runtime. The
 * honest fix is to widen the type to what is really passed; the dishonest ones were a cast at the
 * call site (a lie about the key) and `string` (which deletes key-checking for every UI component).
 *
 * So the boundary is DECLARED instead: this array names exactly the host keys the UI layer is
 * allowed to render, and `packages/app/src/i18n/session-error-keys.test.ts` pins it in both
 * directions — every entry must exist in the app dictionary, and the session-fault taxonomy's key
 * set must equal it. Adding a key here that no host provides, or an arm there that is not listed
 * here, fails that suite by name (ruling 1).
 *
 * Today it is exactly the session-fault taxonomy (`@novaclaw/core/session/session-error`), whose
 * headlines the transcript renders. It is deliberately a hand-written list and not
 * `` `session.error.${string}` ``: a pattern would let a typo compile.
 */
export const HOST_I18N_KEYS = [
  "session.error.interrupted",
  "session.error.invalidRequest",
  "session.error.noRoute",
  "session.error.authentication",
  "session.error.rateLimit",
  "session.error.quotaExceeded",
  "session.error.contentPolicy",
  "session.error.providerInternal",
  "session.error.gatewayTimeout",
  "session.error.transport",
  "session.error.transportEndpoint",
  "session.error.offlineBlocked",
  "session.error.offlineBlockedEndpoint",
  "session.error.invalidProviderOutput",
  "session.error.unknownProvider",
  "session.error.toolFailure",
  "session.error.unknown",
] as const

export type HostI18nKey = (typeof HOST_I18N_KEYS)[number]

export type UiI18nKey = keyof typeof en | HostI18nKey

export type UiI18nParams = Record<string, string | number | boolean>

/**
 * ⚠️ **`t` is declared to return `string`, but the real app translator returns `undefined` for a
 * key its dictionary does not hold** (measured 2026-07-30 against `@solid-primitives/i18n@2.2.1`:
 * `translator()`'s `default:` arm returns the looked-up `value`, which is `undefined` on a miss —
 * it does NOT echo the key back, as several comments in this tree claimed).
 * `packages/app/src/context/language.tsx` casts that away with `as Translator`. A miss is
 * mechanically impossible for a `HostI18nKey` (the ratchet above) and for this package's own
 * bundle, so the declaration is honest for every key a component may pass — but a call site that
 * renders a key it cannot prove exists should still `??` its own fallback rather than trust it.
 */
export type UiI18n = {
  locale: Accessor<string>
  t: (key: UiI18nKey, params?: UiI18nParams) => string
}

function resolveTemplate(text: string, params?: UiI18nParams) {
  if (!params) return text
  return text.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey) => {
    const key = String(rawKey)
    const value = params[key]
    return value === undefined ? "" : String(value)
  })
}

const fallback: UiI18n = {
  locale: () => "en",
  // No host dictionary exists outside a provider, so a `HostI18nKey` cannot be resolved here and
  // the key itself comes back — the caller's `??` fallback is what keeps that off the screen.
  t: (key, params) => {
    const value = key in en ? en[key as keyof typeof en] : undefined
    return resolveTemplate(value ?? String(key), params)
  },
}

const Context = createContext<UiI18n>(fallback)

export function I18nProvider(props: ParentProps<{ value: UiI18n }>) {
  return <Context.Provider value={props.value}>{props.children}</Context.Provider>
}

export function useI18n() {
  return useContext(Context)
}
