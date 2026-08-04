import * as i18n from "@solid-primitives/i18n"
import { createEffect, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@novaclaw/ui/context"
import { Persist, persisted } from "@/utils/persist"
import { dict as en } from "@/i18n/en"
import { dict as uiEn } from "@novaclaw/ui/i18n/en"

export type Locale =
  | "en"
  | "zh"
  | "zht"
  | "ko"
  | "de"
  | "es"
  | "fr"
  | "da"
  | "ja"
  | "pl"
  | "ru"
  | "uk"
  | "ar"
  | "no"
  | "br"
  | "th"
  | "bs"
  | "tr"

type RawDictionary = typeof en & typeof uiEn
type Dictionary = i18n.Flatten<RawDictionary>
type Source = { dict: Record<string, string> }

/** Every i18n key the app can translate — a real union of the ~1862 keys in `en.ts` + the ui bundle. */
export type TranslationKey = keyof Dictionary

export type TranslationParams = Record<string, string | number | boolean>

/**
 * The app's translator. Key-typed: a key that is not in `en.ts` is a compile error, so a raw key
 * like `mcp.status.failed` can no longer reach a user. Anything that accepts a `t` must use THIS
 * alias — declaring `(key: string) => string` is not a looser convenience, it is unsatisfiable
 * (parameters are contravariant, so a key-typed `t` is not assignable to it).
 */
export type Translator = (key: TranslationKey, params?: TranslationParams) => string

/**
 * The ONE escape hatch for a key that genuinely cannot be known at compile time.
 *
 * Use it only where the key is assembled from runtime data that has no closed set — and say in a
 * comment at the call site WHY. Everywhere else, narrow the source to a union instead: a literal
 * union of suffixes still type-checks through template-literal types, and that is strictly better
 * than this, because this function checks nothing at all.
 *
 * ⚠️ A key passed through here is unverified. If it is missing, `@solid-primitives/i18n` returns
 * the key itself and the user sees `some.raw.key` in the UI — which is exactly the live bug
 * (`mcp.status.needs_client_registration`) that key-typing the translator found. So a call site that
 * uses this should either handle the miss (compare the result to the key) or be somewhere a raw key
 * is genuinely impossible.
 *
 * Every use is pinned by `src/i18n/key-typing.test.ts`, a SHRINK-ONLY ledger: adding a site fails
 * the suite by name. Two sites are pinned today.
 */
export function dynamicKey(key: string): TranslationKey {
  return key as TranslationKey
}

function cookie(locale: Locale) {
  return `oc_locale=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`
}

const LOCALES: readonly Locale[] = [
  "en",
  "zh",
  "zht",
  "ko",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "uk",
  "bs",
  "ar",
  "no",
  "br",
  "th",
  "tr",
]

const INTL: Record<Locale, string> = {
  en: "en",
  zh: "zh-Hans",
  zht: "zh-Hant",
  ko: "ko",
  de: "de",
  es: "es",
  fr: "fr",
  da: "da",
  ja: "ja",
  pl: "pl",
  ru: "ru",
  uk: "uk",
  ar: "ar",
  no: "nb-NO",
  br: "pt-BR",
  th: "th",
  bs: "bs",
  tr: "tr",
}

const LABEL_KEY: Record<Locale, keyof Dictionary> = {
  en: "language.en",
  zh: "language.zh",
  zht: "language.zht",
  ko: "language.ko",
  de: "language.de",
  es: "language.es",
  fr: "language.fr",
  da: "language.da",
  ja: "language.ja",
  pl: "language.pl",
  ru: "language.ru",
  uk: "language.uk",
  ar: "language.ar",
  no: "language.no",
  br: "language.br",
  th: "language.th",
  bs: "language.bs",
  tr: "language.tr",
}

const base = i18n.flatten({ ...en, ...uiEn })
const dicts = new Map<Locale, Dictionary>([["en", base]])

const merge = (app: Promise<Source>, ui: Promise<Source>) =>
  Promise.all([app, ui]).then(([a, b]) => ({ ...base, ...i18n.flatten({ ...a.dict, ...b.dict }) }) as Dictionary)

const loaders: Record<Exclude<Locale, "en">, () => Promise<Dictionary>> = {
  zh: () => merge(import("@/i18n/zh"), import("@novaclaw/ui/i18n/zh")),
  zht: () => merge(import("@/i18n/zht"), import("@novaclaw/ui/i18n/zht")),
  ko: () => merge(import("@/i18n/ko"), import("@novaclaw/ui/i18n/ko")),
  de: () => merge(import("@/i18n/de"), import("@novaclaw/ui/i18n/de")),
  es: () => merge(import("@/i18n/es"), import("@novaclaw/ui/i18n/es")),
  fr: () => merge(import("@/i18n/fr"), import("@novaclaw/ui/i18n/fr")),
  da: () => merge(import("@/i18n/da"), import("@novaclaw/ui/i18n/da")),
  ja: () => merge(import("@/i18n/ja"), import("@novaclaw/ui/i18n/ja")),
  pl: () => merge(import("@/i18n/pl"), import("@novaclaw/ui/i18n/pl")),
  ru: () => merge(import("@/i18n/ru"), import("@novaclaw/ui/i18n/ru")),
  uk: () => merge(import("@/i18n/uk"), import("@novaclaw/ui/i18n/uk")),
  ar: () => merge(import("@/i18n/ar"), import("@novaclaw/ui/i18n/ar")),
  no: () => merge(import("@/i18n/no"), import("@novaclaw/ui/i18n/no")),
  br: () => merge(import("@/i18n/br"), import("@novaclaw/ui/i18n/br")),
  th: () => merge(import("@/i18n/th"), import("@novaclaw/ui/i18n/th")),
  bs: () => merge(import("@/i18n/bs"), import("@novaclaw/ui/i18n/bs")),
  tr: () => merge(import("@/i18n/tr"), import("@novaclaw/ui/i18n/tr")),
}

function loadDict(locale: Locale) {
  const hit = dicts.get(locale)
  if (hit) return Promise.resolve(hit)
  if (locale === "en") return Promise.resolve(base)
  const load = loaders[locale]
  return load().then((next: Dictionary) => {
    dicts.set(locale, next)
    return next
  })
}

export function loadLocaleDict(locale: Locale) {
  return loadDict(locale).then(() => undefined)
}

const localeMatchers: Array<{ locale: Locale; match: (language: string) => boolean }> = [
  { locale: "en", match: (language) => language.startsWith("en") },
  { locale: "zht", match: (language) => language.startsWith("zh") && language.includes("hant") },
  { locale: "zh", match: (language) => language.startsWith("zh") },
  { locale: "ko", match: (language) => language.startsWith("ko") },
  { locale: "de", match: (language) => language.startsWith("de") },
  { locale: "es", match: (language) => language.startsWith("es") },
  { locale: "fr", match: (language) => language.startsWith("fr") },
  { locale: "da", match: (language) => language.startsWith("da") },
  { locale: "ja", match: (language) => language.startsWith("ja") },
  { locale: "pl", match: (language) => language.startsWith("pl") },
  { locale: "ru", match: (language) => language.startsWith("ru") },
  { locale: "uk", match: (language) => language.startsWith("uk") },
  { locale: "ar", match: (language) => language.startsWith("ar") },
  {
    locale: "no",
    match: (language) => language.startsWith("no") || language.startsWith("nb") || language.startsWith("nn"),
  },
  { locale: "br", match: (language) => language.startsWith("pt") },
  { locale: "th", match: (language) => language.startsWith("th") },
  { locale: "bs", match: (language) => language.startsWith("bs") },
  { locale: "tr", match: (language) => language.startsWith("tr") },
]

function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    const normalized = language.toLowerCase()
    const match = localeMatchers.find((entry) => entry.match(normalized))
    if (match) return match.locale
  }

  return "en"
}

export function normalizeLocale(value: string): Locale {
  return LOCALES.includes(value as Locale) ? (value as Locale) : "en"
}

function readStoredLocale() {
  if (typeof localStorage !== "object") return
  try {
    const raw = localStorage.getItem("novaclaw.global.dat:language")
    if (!raw) return
    const next = JSON.parse(raw) as { locale?: string }
    if (typeof next?.locale !== "string") return
    return normalizeLocale(next.locale)
  } catch {
    return
  }
}

const warm = readStoredLocale() ?? detectLocale()
if (warm !== "en") void loadDict(warm)

export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext({
  name: "Language",
  gate: false,
  init: (props: { locale?: Locale }) => {
    const initial = props.locale ?? readStoredLocale() ?? detectLocale()
    const [store, setStore, _, ready] = persisted(
      Persist.global("language", ["language.v1"]),
      createStore({
        locale: initial,
      }),
    )

    const locale = createMemo<Locale>(() => normalizeLocale(store.locale))
    const intl = createMemo(() => INTL[locale()])

    const [dict] = createResource(locale, loadDict, {
      initialValue: dicts.get(initial) ?? base,
    })

    // `Translator` is key-typed (`keyof Dictionary`, a ~1862-key union), so a key that is not in
    // `en.ts` + the ui bundle is a COMPILE ERROR. That was not always true: until 2026-07-29
    // `packages/ui`'s `en` was annotated `Record<string, string>`, and its index signature swallowed
    // the app's literal keys in the `typeof en & typeof uiEn` intersection — `keyof Dictionary`
    // collapsed to `string` and the app's `t` was never key-checked at all. Removing that annotation
    // made the union real; this cast then reported 14 pre-existing sites, all now fixed:
    //   · ONE key that did not exist — `mcp.status.needs_client_registration`, a live bug that
    //     rendered the raw key at the user in `dialog-select-mcp.tsx`. (The other four `mcp.status.*`
    //     keys were already in `en.ts`; only that one was missing, in all 19 bundles.)
    //   · Two "dynamic" keys that were nothing of the sort — a `createMemo` returning a widened
    //     object literal, and a field list annotated `label: string`. Both are closed sets and are
    //     now literal unions, so they are checked rather than excused.
    //   · Eleven consumers declaring `(key: string) => string`, which a key-typed `t` cannot satisfy
    //     because parameters are contravariant. They import this `Translator` alias now.
    // A separate sweep then closed 19 PRE-EXISTING `as Parameters<typeof language.t>[0]` casts that
    // were harmless no-ops while `t` took a `string` and became live bypasses the moment it did not.
    // 17 were fixed by narrowing the source; 2 genuinely cannot be and go through `dynamicKey()`,
    // ledgered in `src/i18n/key-typing.test.ts`.
    // ⚠️ The cast itself remains because `@solid-primitives/i18n`'s `translator` types params
    // per-key from the template string; we take one uniform param bag. Do NOT widen `key` back to
    // `string` — that is the whole check, and `en.ts` is the only place to add a key.
    const t = i18n.translator(() => dict() ?? base, i18n.resolveTemplate) as Translator

    const label = (value: Locale) => t(LABEL_KEY[value])

    createEffect(() => {
      if (typeof document !== "object") return
      document.documentElement.lang = locale()
      document.cookie = cookie(locale())
    })

    return {
      ready,
      locale,
      intl,
      locales: LOCALES,
      label,
      t,
      setLocale(next: Locale) {
        setStore("locale", normalizeLocale(next))
      },
    }
  },
})
