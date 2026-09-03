import { describe, expect, test } from "bun:test"
import { PermissionActions } from "@novaclaw/core/permission-actions"
import { dict as en } from "./en"
import { ACTION_LABEL_KEY } from "./permission-action-labels"

/**
 * 🔴 Every gate action has a HUMAN label, and every human label names a real gate action.
 *
 * The permission-rule editor offers `PermissionActions.ALL` in a dropdown. Until 2026-09-04 it
 * rendered each one raw — `label={(value) => value}` — so the control read `kb`, `js`,
 * `provision`, `external_directory_write`. The screen's own comment complained about exactly that
 * ("`kb`, `js` and `provision` in a row teach nobody what they gate"), and the answer already
 * existed: `settings.permissions.tool.<action>.title`/`.description`, a title and a description per
 * action, translated into eighteen locales — and **nothing in the tree rendered a single one of
 * them**. A vocabulary answered in the bundles and thrown away at the call site.
 *
 * Both directions rotted while nobody was looking, which is why both are checked here:
 *
 * · **Actions with no label.** Twenty-two of thirty-five — every capability, delegation and social
 *   action, plus `trash`, `js`, `computer`, `wait`, `resource_status` and `chat_upgrade`. The
 *   labelled thirteen were the original file tools; everything added since arrived unlabelled,
 *   because nothing rendered the labels and so nothing missed them.
 * · **Labels with no action.** Four — `glob`, `grep` and `list`, retired from the permission schema
 *   on 2026-07-30, and `external_directory` (the real gates are the `_read`/`_write` pair). Their
 *   strings outlived them in all eighteen bundles.
 *
 * ⚠️ This is a SET equality, not a floor, and that is the point. A one-directional check would have
 * let either half rot exactly as it did — a missing label falls back to a raw action name that looks
 * deliberate, and a stale label points at a rule nobody can write.
 *
 * ⚠️ English only, deliberately. `i18n/resolve.ts` falls a missing locale key back to English, so
 * `en` is the one bundle whose coverage is load-bearing; `parity.test.ts` owns how far the others
 * have got.
 */
const PREFIX = "settings.permissions.tool."

const labelled = (suffix: ".title" | ".description") =>
  Object.keys(en)
    .filter((key) => key.startsWith(PREFIX) && key.endsWith(suffix))
    .map((key) => key.slice(PREFIX.length, -suffix.length))
    .sort()

describe("every permission action is offered in words", () => {
  test("the scan is real — it finds the keys and the actions we know are there", () => {
    // Non-vacuity: two empty sets are equal, and would make every assertion below pass forever.
    expect(labelled(".title").length).toBeGreaterThan(30)
    expect(PermissionActions.ALL.length).toBeGreaterThan(30)
    expect(labelled(".title")).toContain("bash")
    // The retired four, so this goes red if any of them is ever restored.
    for (const gone of ["glob", "grep", "list", "external_directory"])
      expect(labelled(".title"), `${gone} names no action`).not.toContain(gone)
  })

  test("🔴 titles and actions are the SAME set", () => {
    expect(
      labelled(".title"),
      "a new action needs `settings.permissions.tool.<action>.title` in en.ts, and a retired one takes its rows with it",
    ).toEqual([...PermissionActions.ALL].sort())
  })

  test("🔴 every title has its description beside it", () => {
    // The description is what the row explains itself with; a title alone is the raw verb with
    // better capitalisation.
    expect(labelled(".description")).toEqual(labelled(".title"))
  })

  test("🔴 every key the picker will ask for actually exists in the bundle", () => {
    // `ACTION_LABEL_KEY` is exhaustive over the ACTION union by construction — that is a type error
    // if an action is added unlabelled. What the type cannot check is that each key it names is a
    // real entry in `en`, because `TranslationKey` is satisfied by any member of the union whether
    // or not this particular one was ever written. A key that typechecks and resolves to "" renders
    // as the raw action, which is the exact failure this whole change is about.
    const missing = Object.values(ACTION_LABEL_KEY).filter((key) => !(key in en))
    expect(missing, "these label keys are named by the picker and absent from en.ts").toEqual([])
  })

  test("no label is blank, because a blank one renders as the raw action", () => {
    // `t()` resolves a miss to "" and the picker falls back to the action name on exactly that
    // test, so an empty string here would be a label that silently is not one.
    for (const action of labelled(".title")) {
      expect((en as Record<string, string>)[`${PREFIX}${action}.title`]?.trim(), action).not.toBe("")
      expect((en as Record<string, string>)[`${PREFIX}${action}.description`]?.trim(), action).not.toBe("")
    }
  })
})
