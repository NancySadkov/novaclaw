import * as i18n from "@solid-primitives/i18n"
import { createEffect, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@novaclaw/ui/context"
import { Persist, persisted } from "@/utils/persist"
import { pluralKey, resolveTranslation } from "@/i18n/resolve"
import { dict as en } from "@/i18n/en"
import { dict as uiEn } from "@novaclaw/ui/i18n/en"
// THE locale table + matcher, in the leaf package, because the desktop shell needs the same one
// (`packages/desktop/src/renderer/i18n/index.ts`). Its own 16-entry copy was two short.
import { LOCALES, detectLocale, normalizeLocale, type Locale } from "@novaclaw/schema/locale"

export type { Locale }
export { LOCALES, detectLocale, normalizeLocale }

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

/** The base of a key ending in `.<Suffix>`. A naked parameter, so the conditional distributes. */
type BaseOf<K, Suffix extends string> = K extends `${infer B}.${Suffix}` ? B : never

/**
 * Every plural group the dictionaries declare — a base key carrying BOTH a `.one` and a `.other`
 * form. Derived from `TranslationKey`, so it cannot drift from `en.ts`, and `context.breakdown.other`
 * (no `.one`) is correctly not one.
 */
export type PluralGroup = Extract<BaseOf<TranslationKey, "one">, BaseOf<TranslationKey, "other">>

/**
 * Render a counted phrase in the grammar of the locale in force.
 *
 * ⚠️ Use this and never `t(n === 1 ? "x.one" : "x.other", { count: n })`. That ternary is the
 * English/Germanic two-form rule written into a call site, where no translator can reach it: Slavic
 * languages need one/few/many and Arabic needs six categories, so in ru/uk/pl/bs one of {2–4, 5+} is
 * always grammatically wrong and cannot be fixed from a bundle. `i18n/plural-sites.test.ts` is a
 * shrink-only ledger of the sites that still do it.
 *
 * `count` is interpolated as `{{count}}` and wins over a `count` in `params`.
 */
export type Pluralize = (group: PluralGroup, count: number, params?: TranslationParams) => string

/**
 * The ONE escape hatch for a key that genuinely cannot be known at compile time.
 *
 * Use it only where the key is assembled from runtime data that has no closed set — and say in a
 * comment at the call site WHY. Everywhere else, narrow the source to a union instead: a literal
 * union of suffixes still type-checks through template-literal types, and that is strictly better
 * than this, because this function checks nothing at all.
 *
 * ⚠️ A key passed through here is unverified, and what a miss DOES is not what this comment used to
 * say. `@solid-primitives/i18n@2.2.1` does not echo the key back — its `translator()` returns the
 * looked-up value, i.e. `undefined`, which Solid renders as nothing. `i18n/resolve.ts` closes both
 * outcomes: a miss falls back to English and then to `""`, so it can reach a user as a blank label
 * but never as `some.raw.key`.
 *
 * ⚠️ So the mitigation this comment used to prescribe — *compare the result to the key* — is
 * unreachable and always was; a guard built on it never fires. A call site that must notice a miss
 * tests the result for BLANKNESS, the way `apps/app-label.ts` does.
 *
 * Every use is pinned by `src/i18n/key-typing.test.ts`, a SHRINK-ONLY ledger: adding a site fails
 * the suite by name. ⚠️ Read the count off `LEDGER` there, never from a sentence here — a
 * hand-maintained number beside a mechanically-checked ledger is stale the first time the ledger
 * shrinks, and it has been.
 */
export function dynamicKey(key: string): TranslationKey {
  return key as TranslationKey
}

function cookie(locale: Locale) {
  return `oc_locale=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`
}

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

export const { use: useLanguage, provider: LanguageProvider, context: LanguageContext } = createSimpleContext({
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

    // 🔴 `Translator` is key-typed (`keyof Dictionary`), so a key that is not in `en.ts` + the ui
    // bundle is a COMPILE ERROR. It is fragile in one specific way: annotating either bundle as
    // `Record<string, string>` makes the index signature swallow the other's literal keys in the
    // `typeof en & typeof uiEn` intersection, `keyof Dictionary` collapses to `string`, and `t` is
    // silently never checked again. That has happened, and it shipped a raw key to a user.
    // ⚠️ Do NOT widen `key` back to `string` — that is the whole check, and `en.ts` is the only
    // place to add a key. `src/i18n/key-typing.test.ts` asserts both declarations by exact text,
    // because the bypass ratchet beside it would go green over a translator that checks nothing.
    //
    // ⚠️ `i18n.translator` is deliberately NOT used here. Its `default:` arm returns `undefined` for
    // a key the dictionary lacks, behind a signature that says `string` — so the `as Translator`
    // that used to sit on this line was a cast standing over a lie, and every guard written against
    // it compared the result to the key, which is a thing that never happens.
    // `i18n/resolve.ts` owns the miss: English first, then `""`, never `undefined`, never a key id.
    const active = () => dict() ?? base
    const translate = (key: string, params?: TranslationParams) => resolveTranslation(active(), base, key, params)

    // `translate` accepts any string, so it satisfies the narrower key-typed `Translator` — the
    // assignment goes this way and only this way (parameters are contravariant).
    const t: Translator = translate

    // The key is built from a CLDR category, so it is not a literal the compiler can check; the
    // GROUP is, and `pluralKey` only ever appends a category to it or falls back to `.other`. That
    // is why this lives at the declaration rather than at a call site.
    const plural: Pluralize = (group, count, params) =>
      translate(pluralKey(active(), intl(), group, count), { ...params, count })

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
      plural,
      setLocale(next: Locale) {
        setStore("locale", normalizeLocale(next))
      },
    }
  },
})
