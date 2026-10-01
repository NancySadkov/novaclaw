export const LOCALES = ["en", "de", "zh", "zht", "ja", "ko", "fr", "br", "es"] as const
export type Locale = (typeof LOCALES)[number]

const MATCHERS: ReadonlyArray<{ readonly locale: Locale; readonly match: (language: string) => boolean }> = [
  { locale: "en", match: (language) => language.startsWith("en") },
  { locale: "zht", match: (language) => language.startsWith("zh") && language.includes("hant") },
  { locale: "zh", match: (language) => language.startsWith("zh") },
  { locale: "ko", match: (language) => language.startsWith("ko") },
  { locale: "de", match: (language) => language.startsWith("de") },
  { locale: "es", match: (language) => language.startsWith("es") },
  { locale: "fr", match: (language) => language.startsWith("fr") },
  { locale: "ja", match: (language) => language.startsWith("ja") },
  { locale: "br", match: (language) => language.startsWith("pt") },
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
