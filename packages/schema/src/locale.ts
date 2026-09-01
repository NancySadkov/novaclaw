/**
 * THE locale table, and the one matcher that turns a browser's language preferences into one of them.
 *
 * It lives in the leaf package because two shells need the same answer: the web/app renderer
 * (`packages/app/src/context/language.tsx`) and the desktop shell
 * (`packages/desktop/src/renderer/i18n/index.ts`). They each used to keep their own copy, and the
 * desktop's was two entries short — `th` and `tr` are offered by the app's language picker, and the
 * desktop shell rejected both, so a Turkish or Thai user got the splash, dialogs and CLI alerts in
 * English with nothing reporting it.
 *
 * ⚠️ Deliberately dependency-free (not even `effect`): a table both a browser bundle and an Electron
 * renderer import is exactly the module that must not drag a graph behind it.
 */

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

export const LOCALES: readonly Locale[] = [
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

/**
 * Order matters: `zht` must be tried before `zh`, and `no` covers `nb`/`nn`. Data-driven rather than
 * an `if`-chain because the desktop's `if`-chain version is what drifted — a missing branch reads as
 * "this language is not offered" from every direction except the picker that offers it.
 */
const MATCHERS: ReadonlyArray<{ readonly locale: Locale; readonly match: (language: string) => boolean }> = [
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

/** The best locale for this environment's language preferences; `en` when there is nothing to read. */
export function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    const normalized = language.toLowerCase()
    const match = MATCHERS.find((entry) => entry.match(normalized))
    if (match) return match.locale
  }

  return "en"
}

/** Coerce an arbitrary stored string to a locale we can actually render. */
export function normalizeLocale(value: string): Locale {
  return LOCALES.includes(value as Locale) ? (value as Locale) : "en"
}
