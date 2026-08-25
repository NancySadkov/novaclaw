export * as SkillBuiltin from "./builtin"

import RESEARCH from "./builtin/research/SKILL.txt"

/**
 * Skills that SHIP WITH THE PRODUCT, available on a machine with no skills directory and no network.
 *
 * 🔴 **Why bundled in code rather than copied to disk at boot.** Same argument `agent/officer-name.ts`
 * makes for the name pool: a capability the product promises must not depend on an assets directory
 * surviving packaging, a first-boot copy succeeding, or a user not having deleted a folder. A skill
 * that is sometimes there is a skill no prompt can rely on. The `import … from "*.txt"` route is the
 * one this repo already PROVES for shipped text (`tool/docs/*.txt`, `plugin/command/*.txt`), so the
 * content lands inside the compiled binary with no packaging step to forget.
 *
 * ⚠️ `.txt` and not `.md` on purpose: `*.md` has a type declaration in this repo but NOTHING imports
 * one at runtime, so that loader is unproven, while `.txt` is load-bearing in two shipped modules
 * already. The file is a complete SKILL.md in every other respect — change the extension to drop it
 * into a skills directory unchanged.
 *
 * ⚠️ **A user's own skill of the same name WINS.** These are seeded before discovery runs, so a file
 * in the config dir or a project's `.novaclaw/skills` overrides the bundled copy and the registry logs
 * the override. Shipping a default must never take away the ability to replace it.
 */
export interface Builtin {
  readonly name: string
  readonly description: string
  /** The skill body, frontmatter already removed. */
  readonly content: string
}

/**
 * Split `---\n…\n---\n` frontmatter off a bundled SKILL.md.
 *
 * ⚠️ The frontmatter is KEPT IN THE FILE deliberately, so `builtin/research/SKILL.txt` is a valid
 * standalone skill someone can copy into their own skills directory unchanged. That means the bundled
 * copy has to strip it here — shipping the raw file would push `name:` and `description:` into the
 * model's context as if they were guidance.
 */
const parse = (source: string, expected: string): Builtin => {
  const normalised = source.replaceAll("\r\n", "\n")
  const match = /^---\n([\s\S]*?)\n---\n/.exec(normalised)
  if (!match) throw new Error(`bundled skill "${expected}" has no frontmatter`)
  const front = match[1]!
  const field = (key: string): string => {
    const found = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(front)
    if (!found) throw new Error(`bundled skill "${expected}" is missing "${key}"`)
    return found[1]!.trim()
  }
  const name = field("name")
  // A mismatch here means the file was renamed without updating the registration, and the officer
  // prompt that names the skill would then point at nothing.
  if (name !== expected) throw new Error(`bundled skill declares name "${name}", expected "${expected}"`)
  return { name, description: field("description"), content: normalised.slice(match[0].length).trim() }
}

/** Every skill compiled into this build. */
export const ALL: readonly Builtin[] = [parse(RESEARCH, "research")]

/** The research commandments, named so an officer's prompt can reference it without a magic string. */
export const RESEARCH_SKILL = "research"
