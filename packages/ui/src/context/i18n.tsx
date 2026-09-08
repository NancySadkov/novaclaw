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
  "session.error.modelMissing",
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

/** The base of a key ending in `.<Suffix>`. A naked parameter, so the conditional distributes. */
type BaseOf<K, Suffix extends string> = K extends `${infer B}.${Suffix}` ? B : never

/**
 * Every plural group THIS bundle declares — a base carrying both a `.one` and a `.other` form.
 * Derived from `en.ts`, so it cannot drift. The host's `PluralGroup` is a superset (its own keys
 * plus these), which is what lets `packages/app` hand its `plural` straight into the provider.
 */
export type UiPluralGroup = Extract<BaseOf<keyof typeof en, "one">, BaseOf<keyof typeof en, "other">>

/**
 * ⚠️ **`t` is declared to return `string`, but the real app translator returns `undefined` for a
 * key its dictionary does not hold** (measured 2026-07-30 against `@solid-primitives/i18n@2.2.1`:
 * `translator()`'s `default:` arm returns the looked-up `value`, which is `undefined` on a miss —
 * it does NOT echo the key back, as several comments in this tree claimed).
 * `packages/app/src/context/language.tsx` casts that away with `as Translator`. A miss is
 * mechanically impossible for a `HostI18nKey` (the ratchet above) and for this package's own
 * bundle, so the declaration is honest for every key a component may pass — but a call site that
 * renders a key it cannot prove exists should test the result for BLANKNESS. Not `??`: the return
 * is a `string`, so a nullish fallback beside it is dead code.
 */
export type UiI18n = {
  locale: Accessor<string>
  t: (key: UiI18nKey, params?: UiI18nParams) => string
  /**
   * A counted phrase in the grammar of the locale in force. ⚠️ Never
   * `t(n === 1 ? "x.one" : "x.other")`: that bakes the English two-form rule into a call site that
   * no bundle can fix for ru/uk/pl/bs/ar. `packages/app/src/i18n/plural-sites.test.ts` bans the
   * ternary under `ui/src` and `session-ui/src`; this is the call that replaces it. `count` is
   * interpolated as `{{count}}`.
   */
  plural: (group: UiPluralGroup, count: number, params?: UiI18nParams) => string
}

function resolveTemplate(text: string, params?: UiI18nParams) {
  if (!params) return text
  return text.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey) => {
    const key = String(rawKey)
    const value = params[key]
    return value === undefined ? "" : String(value)
  })
}

const englishRules = new Intl.PluralRules("en")

/**
 * The English translator, for surfaces with no provider and for tests of plain helpers that take
 * a `t` (`colleague-row.ts`). Exported under a name that says what it is: it is not a stand-in for
 * the host's translator, it IS English.
 */
export const englishI18n: UiI18n = {
  locale: () => "en",
  // No host dictionary exists outside a provider, so a `HostI18nKey` cannot be resolved here. It
  // resolves to `""`, never to the key: a key id on screen is what `packages/app/src/i18n/resolve.ts`
  // was just closed against, and this fallback was the last path in the tree that could produce one.
  t: (key, params) => {
    const value = key in en ? en[key as keyof typeof en] : undefined
    return value === undefined ? "" : resolveTemplate(value, params)
  },
  // English has exactly `one` and `other`, and `en.ts` carries both for every group, so the
  // category `Intl.PluralRules` selects is always a key. The suffix is assembled, never spelled:
  // the plural-sites ratchet reads a spelled `"<group>.one"` as a hand-rolled selection.
  plural: (group, count, params) => {
    const category = englishRules.select(count)
    const key = `${group}.${category}` as keyof typeof en
    const value = key in en ? en[key] : en[`${group}.other`]
    return resolveTemplate(value, { ...params, count })
  },
}

const fallback = englishI18n

const Context = createContext<UiI18n>(fallback)

export function I18nProvider(props: ParentProps<{ value: UiI18n }>) {
  return <Context.Provider value={props.value}>{props.children}</Context.Provider>
}

export function useI18n() {
  return useContext(Context)
}
