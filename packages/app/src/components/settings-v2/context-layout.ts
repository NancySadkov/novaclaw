/**
 * WHERE each part of the composed prompt is changed from — the client's half of "view the layout".
 *
 * 🔴 **Every slot in the kernel table must appear here, and that is enforced by a test, not by care**
 * (`context-layout.test.ts`). The failure this prevents is the one the page exists to end: a
 * hand-maintained inventory that silently stops covering the thing it inventories. If a slot is added
 * to `context-template.ts` and forgotten here, the layout screen keeps rendering and quietly lies by
 * omission — the same shape as `SystemAccounting.BLOCKS` before it was derived.
 *
 * ⚠️ Deliberately SEPARATE from `system-prompt.tsx`, which is a Solid component with context
 * dependencies. This module is data, so the drift test can import it without a DOM.
 *
 * ⚠️ `auto` is not a synonym for "the kernel decided". It means the content is DERIVED at compose time
 * from state changed elsewhere (recalled memory from the memory graph, project grounding from the
 * folder), so there is no field to point at — and saying "fixed" would send the user hunting for one.
 * A value they cannot see or change must say so rather than leaving them wondering (AGENTS.md
 * principle 12d, and the greying-control rule: *"a greyed control invites the user to wonder what
 * would unlock it"*).
 *
 * ⚠️ The POSITION of every row is kernel-fixed and deliberately NOT a per-row badge; the section copy
 * says it once, with the reason. Twenty-one rows each repeating "and you cannot move me" is noise that
 * buries the one column that varies.
 */
export type SlotOrigin = "settings" | "agent" | "model" | "files" | "project" | "session" | "auto"

export const SLOT_ORIGIN: Readonly<Record<string, SlotOrigin>> = {
  // The instance's own settings (this app, these Settings tabs).
  persona: "settings",
  expertiseHint: "settings",
  // The model's entry in Settings → Models → Configure: the correction and the operator's rank.
  modelPrePrompt: "model",
  taxonomyHint: "model",
  // The colleague or the chat: its Profile/Work/Mind fields, its session override, folder and goal.
  systemPromptOverride: "agent",
  agentIdentity: "agent",
  agentSystem: "agent",
  organization: "agent",
  memoryStance: "agent",
  workspace: "agent",
  goal: "agent",
  // Files on disk: AGENTS.md (the instance's, the project's walk-up) and the loaded skills.
  base: "files",
  // The folder's `novaclaw.json` — portable, travels inside a cloned repo, and may only ever narrow.
  projectScope: "project",
  // 🔴 `durable` is not "agent": there is no field anywhere that holds it. The COLLEAGUE writes it, at
  // runtime, through its own tools (`durable_set` / `durable_clear`), and the kernel materialises it
  // into the prompt after a rewrite. A reader sent to "the colleague's settings" would hunt for an
  // editor that does not exist, which is the failure `auto` was coined for one line down.
  durable: "session",
  // Derived at compose time from state that lives elsewhere; there is no field for these.
  toolDiscovery: "auto",
  perception: "auto",
  delegation: "auto",
  projectGrounding: "auto",
  memoryRecall: "auto",
  todoReminder: "auto",
  toolCatalogueUpdate: "auto",
  maxSteps: "auto",
}
