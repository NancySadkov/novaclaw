import { describe, expect, test } from "bun:test"
import { ContextTemplate } from "@novaclaw/core/session/context-template"
import { dict as en } from "@/i18n/en"
import { SLOT_ORIGIN, type SlotOrigin } from "./context-layout"

/**
 * The layout screen is only worth having if it covers EVERY part of the prompt, and coverage is the
 * one thing a hand-maintained list loses silently. So the two directions are asserted here rather
 * than trusted:
 *
 *   1. every slot in the kernel table has a provenance entry and every user-visible string it needs,
 *   2. nothing in the screen describes a slot the kernel does not have.
 *
 * The failure this prevents is not a crash. It is a screen that keeps rendering, keeps looking
 * complete, and quietly omits the block an agent was just given — which is exactly what happened to
 * the previous hand-written block inventory (`SystemAccounting.BLOCKS`), and why the table itself is
 * imported instead of transcribed.
 */
describe("Settings → System prompt — the layout screen covers the kernel's table", () => {
  test("every slot has a provenance entry, and there are no entries for slots that do not exist", () => {
    const names: readonly string[] = ContextTemplate.SLOTS.map((slot) => slot.name)
    const unknown = Object.keys(SLOT_ORIGIN).filter((name) => !names.includes(name))
    expect(unknown).toEqual([])
    const missing = names.filter((name) => SLOT_ORIGIN[name] === undefined)
    expect(missing).toEqual([])
    // ⚠️ Equal LENGTHS, not merely "no unknown and no missing": the two checks above are per-name and
    // would both pass on a duplicated or renamed entry that happened to net out. The count is the
    // cheap fact that catches a table which has quietly stopped being one-to-one.
    expect(Object.keys(SLOT_ORIGIN).length).toBe(names.length)
  })

  test("every slot has a name, an origin label, a channel label and a volatility label in English", () => {
    // The component's three lookups, checked against the real dictionary rather than against the
    // component's own literals. A slot added to the kernel table without copy would otherwise render
    // the raw key ("settings.contextLayout.slot.<name>") to a user, which is the class of lie this
    // whole page is a fix for.
    const origins: readonly SlotOrigin[] = ["settings", "agent", "model", "files", "project", "session", "auto"]
    for (const slot of ContextTemplate.SLOTS) {
      expect(en[`settings.contextLayout.slot.${slot.name}` as keyof typeof en], `slot label for ${slot.name}`).toBeString()
      const origin = SLOT_ORIGIN[slot.name] as SlotOrigin
      expect(origins, `origin "${origin}" of ${slot.name} must be one of the six kinds`).toContain(origin)
      expect(en[`settings.contextLayout.origin.${origin}` as keyof typeof en], `origin label for ${origin}`).toBeString()
      expect(
        en[`settings.contextLayout.channel.${slot.channel}` as keyof typeof en],
        `channel label for ${slot.channel}`,
      ).toBeString()
      expect(
        en[`settings.contextLayout.volatility.${slot.volatility}` as keyof typeof en],
        `volatility label for ${slot.volatility}`,
      ).toBeString()
    }
  })

  test("🔴 every origin claims a place the user can actually go, and `auto` claims nothing", () => {
    // A provenance column that says "the colleague's settings" for something no setting controls is a
    // worse lie than no column: it sends the reader somewhere and leaves them there. The count of
    // `auto` slots is not an assertion (it moves with the table) — what is asserted is that the four
    // NAMED origins are used, and that `auto` is spelled as the absence of a place rather than as
    // "the kernel", which reads as a place and is not one.
    const used = new Set(Object.values(SLOT_ORIGIN))
    for (const origin of ["settings", "agent", "model", "files", "auto", "session"] as const) expect(used).toContain(origin)
    expect(en["settings.contextLayout.origin.auto" as keyof typeof en]).not.toContain("kernel")
  })

  test("the slots the page must NOT mislabel: base is files, projectScope is the folder, goal is the pair", () => {
    // Pinned by name because these three are the ones a plausible edit gets wrong (all three feel like
    // "the kernel"): `base` is the epoch-frozen baseline from AGENTS.md and skills, `projectScope` is
    // the kernel's own rule for the working folder, generated from the permission mode
    // (`SystemCompose.projectScopeSection`) — NOT from a file, which is what this comment said until
    // 2026-09-17, and not from an agent — and `goal` is set by the user or a superior.
    expect(SLOT_ORIGIN.base).toBe("files")
    expect(SLOT_ORIGIN.projectScope).toBe("project")
    expect(SLOT_ORIGIN.goal).toBe("agent")
    // The one epoch-frozen slot is `base`, and the screen states its volatility in words — if that
    // ever changes, the row would promise a freeze that is not in force.
    expect(ContextTemplate.SLOTS.filter((slot) => slot.volatility === "epoch").map((slot) => slot.name)).toEqual(["base"])
  })
})
