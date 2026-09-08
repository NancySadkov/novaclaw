import { dict as en } from "@/i18n/en"
import { pluralKey, resolveTranslation } from "@/i18n/resolve"

/**
 * The ONE language stub every render test in this directory uses.
 *
 * 🔴 It resolves through `@/i18n/resolve`, the same module the real context calls — it does not
 * re-implement lookup. Eleven files used to hand-roll `en[key] ?? key`, and that copy carried two
 * defects of its own:
 *
 * · **It echoed the key on a miss.** The real app renders a miss as `""` — never as `some.raw.key`
 *   — so a render test under the hand-rolled stub showed a key id where the app shows nothing, and
 *   therefore could not catch a missing key at all. It was a control that could not fail.
 * · **It was eleven copies of the context's shape.** Adding `plural` to the real context broke every
 *   one of them at once, in files whose subject was not language. A stub that mirrors an interface
 *   by hand goes stale on exactly the change it should have caught.
 *
 * So: one delegating stub, and the next member added to the context is added here once.
 */
export const languageStub = {
  t: (key: string, params?: Record<string, string | number | boolean>) => resolveTranslation(en, en, key, params),
  plural: (group: string, count: number, params?: Record<string, string | number | boolean>) =>
    resolveTranslation(en, en, pluralKey(en, "en", group, count), { ...params, count }),
  locale: () => "en",
  setLocale: () => {},
}
