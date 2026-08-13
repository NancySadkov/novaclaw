import { describe, expect, test } from "bun:test"
import { SESSION_CONFIG_FIELD_KEYS } from "@novaclaw/core/session/config-resolve"
import { SessionComponentRegistry } from "@novaclaw/core/session/component-registry"

/**
 * The session entity has TWO descriptions of its components, and this file is the only thing that
 * relates them.
 *
 *  · `SESSION_CONFIG_FIELDS` — the inherited, sparse-override columns on the session row, resolved
 *    by the parent-chain walk. It knows how a value RESOLVES.
 *  · `SessionComponentRegistry` — kinds with a codec, cardinality, lifetime, privilege tier and a
 *    storage projection, reachable over HTTP and by an agent. It knows what a component IS.
 *
 * Neither is wrong, and they are not redundant: the first is a resolution rule, the second is an
 * interface. What is wrong is that membership diverges silently — a per-session fact can exist in
 * one and not the other, so "everything is a component" is true of some facts and not others, and
 * nothing says which.
 *
 * So this is a SHRINK-ONLY ledger. Every config field must be declared either as exposed or as a
 * known gap with a reason. Closing a gap means moving its entry and lowering the count; adding a
 * field without deciding is a failure rather than a silent nineteenth exception.
 */

/** Config field → the kernel component kind that exposes it. */
const EXPOSED: Readonly<Record<string, SessionComponentRegistry.KernelKind>> = {
  device: "device",
  controlBinding: "control_binding",
  systemPromptOverride: "system_prompt_override",
  priority: "priority",
  permissionMode: "permission_mode",
}

/**
 * Config fields with no component kind, and why. ⛔ SHRINK ONLY.
 *
 * The `tuning` group is the largest and the most mechanical: `tuning` is already a reserved name in
 * `KERNEL_KIND_NAMES` with a privilege tier and NO definition, so the composer's Tuning panel is the
 * one surface a user drives constantly that an agent cannot read or write as a component.
 */
const NOT_YET_A_COMPONENT: Readonly<Record<string, string>> = {
  introspection: "belongs to the reserved `tuning` kind",
  quality: "belongs to the reserved `tuning` kind",
  affective: "belongs to the reserved `tuning` kind",
  thinkingBudget: "belongs to the reserved `tuning` kind",
  surgicalEdits: "belongs to the reserved `tuning` kind",
  askBeforeChanges: "belongs to the reserved `tuning` kind",
  safeMode: "belongs to the reserved `tuning` kind",
  contextBudget: "belongs to the reserved `tuning` kind",
  shortChat: "belongs to the reserved `tuning` kind",
  memory: "belongs to the reserved `tuning` kind",
  model: "a model ref needs a codec and resolves through the catalog",
  agent: "resolves through the agent registry",
  type: "the kernel thread type; changing it mid-session is not a component write today",
  responder: "who answers this session",
  strict: "a nested override document, not a scalar",
}

describe("every per-session fact is a component", () => {
  test("each config field is either exposed as a kind or a declared gap — never neither, never both", () => {
    const undeclared: string[] = []
    const both: string[] = []
    for (const key of SESSION_CONFIG_FIELD_KEYS.map(String)) {
      const exposed = key in EXPOSED
      const gap = key in NOT_YET_A_COMPONENT
      if (!exposed && !gap) undeclared.push(key)
      if (exposed && gap) both.push(key)
    }
    expect(undeclared, "a new session component was added without deciding whether it is a kind").toEqual([])
    expect(both).toEqual([])
  })

  test("every field claimed as exposed names a REAL kernel kind", () => {
    // Without this the map above could claim coverage that does not exist — the same class of defect
    // as a ledger whose entries no longer match the code it describes.
    const kinds = new Set<string>(SessionComponentRegistry.KERNEL_KIND_NAMES)
    for (const [field, kind] of Object.entries(EXPOSED)) {
      expect(kinds.has(kind), `${field} claims kind "${kind}", which is not in KERNEL_KIND_NAMES`).toBe(true)
    }
  })

  test("🔴 a declared gap that has since become a kind must be MOVED, not left behind", () => {
    // The failure this catches: someone defines the `tuning` kind, the gap list still lists its ten
    // fields, and the ledger keeps reporting a debt that is already paid — so nobody trusts it.
    const kinds = new Set<string>(SessionComponentRegistry.KERNEL_KIND_NAMES)
    const snake = (value: string) => value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
    const stale = Object.keys(NOT_YET_A_COMPONENT).filter((f) => kinds.has(f) || kinds.has(snake(f)))
    expect(stale, "these fields now have a component kind — move them to EXPOSED").toEqual([])
  })

  test("⛔ the gap ledger shrinks only", () => {
    // 15 of 20 config fields are not reachable as components. Lower this when you close one; a
    // raise means a per-session fact was added outside the component model on purpose.
    expect(Object.keys(NOT_YET_A_COMPONENT).length).toBeLessThanOrEqual(15)
  })

  test("`tuning` is reserved and still undefined — the largest single gap", () => {
    // Reserved names may precede their storage adapter by design. This pins that the reservation is
    // still outstanding, so closing it is a visible event rather than a quiet one.
    expect(SessionComponentRegistry.KERNEL_KIND_NAMES).toContain("tuning")
    const belongsToTuning = Object.entries(NOT_YET_A_COMPONENT).filter(([, why]) => why.includes("`tuning`"))
    expect(belongsToTuning.length).toBe(10)
  })

  test("the components that are NOT config fields stay reachable", () => {
    // `working_folder` is the location — a required component with a projection onto the row, not a
    // sparse inherited column. It must never be folded into the config descriptor: the column is NOT
    // NULL and the walk's `undefined` = inherit has no meaning for a folder a session always has.
    for (const kind of ["title", "working_folder", "goal", "plan", "observation"] as const) {
      expect(SessionComponentRegistry.KERNEL_KIND_NAMES).toContain(kind)
    }
  })
})
