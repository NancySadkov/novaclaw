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
  // The ten switches of the composer's Tuning panel share ONE singleton component; a component kind
  // is not required to be one-per-field.
  introspection: "tuning",
  quality: "tuning",
  affective: "tuning",
  thinkingBudget: "tuning",
  surgicalEdits: "tuning",
  askBeforeChanges: "tuning",
  safeMode: "tuning",
  contextBudget: "tuning",
  shortChat: "tuning",
  memory: "tuning",
  // Closed 2026-08-13. Each of the five needed a decision about its VALUE rather than a projection,
  // and the decisions are recorded on the definitions themselves:
  //   · `model` validates against the catalog on write — the registry it "resolves through" is now
  //     consulted at the write, not at the next turn where a bad ref reads as a provider outage.
  //   · `agent` does NOT validate: the agent registry is location-scoped and this registry is a
  //     global node. The runner already falls back for an unknown name.
  //   · `session_type` is READ-ONLY to an agent. Attendance derives from the chain root's type, so
  //     an agent that could write it would declare itself attended and leave the unattended
  //     confinement stance — the escalation that arm exists to prevent.
  //   · `responder` is ONE-WAY: an agent may hand control to a human, only a human hands it back.
  //   · `strict` is the one that can be REMOVED, because `StrictSwitched` is nullable.
  model: "model",
  agent: "agent",
  type: "session_type",
  responder: "responder",
  strict: "strict",
}

/**
 * Config fields with no component kind, and why. ⛔ SHRINK ONLY.
 *
 * EMPTY since 2026-08-13 — every config field is reachable as a component. Keep the map: an entry
 * here is how a field that genuinely cannot be one gets declared instead of quietly missing, and the
 * count assertion below is what stops it from growing back.
 */
const NOT_YET_A_COMPONENT: Readonly<Record<string, string>> = {}

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
    void snake
    expect(stale, "these fields now have a component kind — move them to EXPOSED").toEqual([])
  })

  test("⛔ the gap ledger shrinks only", () => {
    // 0 of 20. It reached zero on 2026-08-13; a raise means a per-session fact was added outside the
    // component model on purpose, which is a decision that belongs in a commit message.
    expect(Object.keys(NOT_YET_A_COMPONENT).length).toBeLessThanOrEqual(0)
  })

  test("`tuning` carries every switch that claims it", () => {
    // It was a reserved name with a tier and no definition until 2026-08-13. Now that it exists, the
    // claim each of the ten switches makes above has to be true of the codec — otherwise a field
    // would be marked covered by a component that does not actually carry it.
    const claiming = Object.entries(EXPOSED)
      .filter(([, kind]) => kind === "tuning")
      .map(([field]) => field)
      .sort()
    expect(claiming.length).toBe(10)
    expect(Object.keys(SessionComponentRegistry.Tuning.fields).sort()).toEqual(claiming)
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
