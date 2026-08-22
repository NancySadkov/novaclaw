import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * TWO DESTRUCTIVE BUTTONS ON ONE SCREEN MUST NOT READ ALIKE.
 *
 * 🔴 Measured in the running app 2026-08-22: the Health tab already carries "Erase everything" — the
 * FULL install reset — and the new memory control first shipped as "Erase everything every agent
 * remembers". Two danger-styled buttons whose labels open with the same words, on one screen, is how
 * somebody reaching for "just the memories" resets their instance. The owner's framing was the
 * contrast itself: erase the RAGs *"without resetting entire Novaclaw install"*.
 *
 * ⚠️ A label test, which is unusual — but the hazard is not in either control's behaviour. Both are
 * correct and confirm-gated. It lives in the two of them being read side by side, which only a rule
 * about the PAIR can hold.
 */

const en = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "i18n", "en.ts"),
  "utf8",
)

/**
 * Read one i18n value.
 *
 * ⚠️ Deliberately NOT a regex: the key contains dots and the value may sit on its own line, and a
 * pattern written through a shell heredoc lost its escapes twice today — `\s` arriving as `s`
 * matched nothing while the file was perfectly correct. Index arithmetic cannot be mangled.
 */
const value = (key: string): string => {
  const at = en.indexOf(`"${key}":`)
  if (at === -1) return ""
  const open = en.indexOf('"', at + key.length + 3)
  if (open === -1) return ""
  let out = ""
  for (let i = open + 1; i < en.length; i++) {
    const ch = en[i]
    if (ch === "\\") {
      out += en[i + 1] ?? ""
      i += 1
      continue
    }
    if (ch === '"') break
    out += ch
  }
  return out
}

describe("the memory erase reads differently from the install reset", () => {
  test("the label names MEMORY", () => {
    const label = value("settings.health.eraseMemory")
    expect(label).toBeTruthy()
    expect(label.toLowerCase()).toContain("memory")
  })

  test("🔴 it does not open with the install reset's words", () => {
    // "Erase everything" is the factory reset's label, and it sits in the same tab.
    expect(value("settings.health.eraseMemory").toLowerCase().startsWith("erase everything")).toBe(false)
  })

  test("the confirmation says what SURVIVES, not only what goes", () => {
    // A destructive confirm that lists only losses reads as "you lose everything" and gets cancelled
    // by the people who actually wanted it.
    const description = value("settings.health.eraseMemory.confirm.description")
    expect(description.toLowerCase()).toContain("untouched")
    expect(description.toLowerCase()).toContain("nova")
  })
})
