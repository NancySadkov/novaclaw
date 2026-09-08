export * as ConfigAgentPlugin from "./agent"

import { define } from "../../plugin/internal"
import type { HostPluginContext as PluginContext } from "@novaclaw/plugin/v2/effect"
import { Effect } from "effect"
import { AgentV2 } from "../../agent"
import { AgentPlugin } from "../../plugin/agent"
import { AgentConfigStore } from "../../agent-config-store"
import { Config } from "../../config"
import { ConfigStoreWrite } from "../../config-store-write"
import { ConfigAgent } from "../agent"
import { ModelV2 } from "../../model"
import type { Permission } from "@novaclaw/schema/permission"

/** The plugin-facing agent draft (what ctx.agent.transform hands its callback). */
type AgentDraft = Parameters<Parameters<PluginContext["agent"]["transform"]>[0]>[0]

// Agent identity and authority have exactly one runtime source: the instance-wide
// `AgentConfigStore` (ordered layers per agent), exposed through the HTTP config surface. A project
// directory is untrusted content, so its markdown can never mint an officer or alter a stored one's
// prompt, model, work choices, or permission rules. The global `permissions` ruleset reads from the
// settings store's synthetic document (the only document post-8c).
export const Plugin = define({
  id: "config-agent",
  capabilities: ["agentConfigStore", "config"],
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const store = yield* AgentConfigStore.Service
    yield* ctx.agent.transform(
      Effect.fn(function* (draft) {
        const entries = yield* config.entries()
        const files = entries.filter((entry): entry is Config.Document => entry.type === "document")

        const global = files.flatMap((file) => file.info.permissions ?? [])
        const storedDefault = yield* store.getDefault()
        if (storedDefault !== undefined) draft.default(AgentV2.ID.make(storedDefault))
        for (const current of draft.list()) {
          draft.update(current.id, (agent) => agent.permissions.push(...global))
        }

        // Config-borne agents from the store (each agent's layers apply in order)…
        const stored = yield* store.agents()
        for (const [name, layers] of Object.entries(stored))
          for (const item of layers) applyItem(draft, AgentV2.ID.make(name), item, global)
      }),
    )

    // v0.2.0-prep B7 / ruling 3 — the transform above reads the store, but `state.ts` only re-runs it
    // on an explicit `.reload()`, and nothing on the config-write path called one. So editing an agent
    // in Settings took effect only when the whole layer graph was destroyed. This hands THIS location's
    // re-materialise to `ConfigStoreWrite.apply` — the one place every config write commits — for the
    // life of this plugin's scope. `ctx.agent.reload` IS `AgentV2.Service.reload` (plugin/host.ts), so
    // no extra service requirement is introduced. Registered AFTER the transform so the first thing a
    // write can trigger is a materialisation that already includes it.
    yield* ConfigStoreWrite.registerReload("agents", ctx.agent.reload)
  }),
})

/** Apply ONE config fragment for one agent onto the draft (the historical per-document merge body).
 *
 *  🔴 A PROTECTED agent's fragment is dropped whole. Nova is this instance's governing agent and its
 *  identity is seeded in code (`plugin/agent.ts`), so a stored layer named `nova`
 *  must not be able to rewrite its brief, hide it, disable it or hand it a different permission set —
 *  *"the charter is not editable from inside"* (AGENTS.md, the structural metaphor). Dropped rather
 *  than merged field-by-field: a partial override is the shape that looks harmless and still lands the
 *  one field that matters. The refusal is LOUD — a silent drop is how a user concludes the product is
 *  broken rather than that the write was refused. */
function applyItem(draft: AgentDraft, agentID: AgentV2.ID, item: ConfigAgent.Info, global: Permission.Ruleset) {
  if (AgentV2.isProtected(agentID)) {
    console.warn(
      `config: ignoring a definition for "${agentID}" — it is this instance's governing agent and its ` +
        `profile is fixed in code. Create your own agent instead, or edit any other one.`,
    )
    return
  }
  // 🔴 `disabled` PAUSES; it does not remove (owner decision, 2026-08-23 — `notes/named-agents.md`).
  //
  // It used to `draft.remove(agentID)`, which was a fourth removal door bypassing every guarantee of
  // `agent/retire.ts` — no `AgentUsage.forget`, no `archiveChats`, no `agent:<id>` → `retired:<id>:<at>`
  // — reachable from an ordinary config write and unconfirmed. Retirement is CONFIRM-GATED by its own
  // definition and a config write carries no confirmation, so this can never have been a retirement.
  //
  // Three things that removal broke, and marking fixes:
  //   · the colleague's chat was left LIVE but DOORLESS — the roster row is the only way into it;
  //   · its id left the roster, so `planHire`'s `taken` set no longer held it and `OfficerName.pick`
  //     could redraw it — handing the NEXT colleague the paused one's cabinet at `agent:<id>`;
  //   · usage kept accruing to a name nobody could see.
  //
  // ⚠️ The "cannot act" half is NOT lost by staying on the roster: `permission.ts` reads `paused` and
  // answers `missingAgentPermissions` — deny `*` on `*` — which is the same verdict a removed agent
  // already produced through `agents.resolve` returning undefined. The effect is preserved; only the
  // collateral damage is gone.
  // ⚠️ A MUTATOR, not a mapper. `Draft.update` is `(id, fn: (agent) => void)` and IGNORES the return
  // value, so `(agent) => ({ ...agent, paused: true })` set nothing — and because `update` creates
  // the record when it is absent, it also minted a blank `Info.empty` agent for an id that had none.
  // The gate caught it as two unrelated-looking failures in the plugin suite.
  if (item.disabled) {
    // ⚠️ Only an agent that EXISTS is paused. `Draft.update` creates the record when it is absent, so
    // an unguarded call would mint a blank `Info.empty` ghost on the roster for a config line
    // disabling an agent nobody ever defined — a paused colleague with no name and no profile.
    // Disabling something that is not there is a no-op, which is what it reads as.
    if (draft.get(agentID) !== undefined)
      draft.update(agentID, (agent) => {
        agent.paused = true
      })
    return
  }

  const exists = draft.get(agentID) !== undefined
  draft.update(agentID, (agent) => {
    if (!exists) {
      // 🔴 A hired colleague stands on the SAME floor as a built-in. Without this it starts from
      // `permissions: []` (`schema/agent.ts`) and every unmatched action falls to the evaluator's
      // `ask`, which the assert path turns into a refusal — measured 2026-08-21 through both real
      // plugins: `read` came back `ask` while the shipped mode still granted `bash`, i.e. an officer
      // that could run a shell command and could not look at a file.
      //
      // `officer` = a PRIMARY agent, which is what a roster colleague is. It widens the floor by two
      // actions — addressing a peer, and spawning a helper that runs as ITSELF — because "top level
      // executive agents who can communicate with each other and spawn the nameless sub-agents" is
      // the metaphor's own sentence, both halves. Config-defined SUB-agents are nameless staff and
      // get the floor without either, so staff cannot staff. Hiring stays Nova's regardless
      // (`tool/colleague.ts` → mayStaff). The model-facing spawn tool cannot name a different agent;
      // operator-side session creation remains a separate, explicit authority surface.
      const officer = (item.mode ?? agent.mode) === "primary"
      // ⚠️ `scratchDirsFor(agentID)`, not the shared `SCRATCH_DIRS`: a colleague's OWN workspace is
      // part of its floor, so assigning it to a project does not take away the place it keeps notes
      // and drafts. See `AgentPlugin.scratchDirsFor` for why that matters.
      agent.permissions.push(...AgentPlugin.floor({ scratchDirs: AgentPlugin.scratchDirsFor(agentID), officer }))
      agent.permissions.push(...global)
    }
    if (item.model !== undefined) {
      const model = ModelV2.parse(item.model)
      agent.model = { id: model.modelID, providerID: model.providerID, variant: agent.model?.variant }
    }
    if (item.variant !== undefined && agent.model !== undefined) {
      agent.model.variant = ModelV2.VariantID.make(item.variant)
    }
    if (item.request !== undefined) {
      Object.assign(agent.request.headers, item.request.headers ?? {})
      Object.assign(agent.request.body, item.request.body ?? {})
    }
    if (item.system !== undefined) agent.system = item.system
    if (item.name !== undefined) agent.name = item.name
    if (item.title !== undefined) agent.title = item.title
    if (item.personality !== undefined) agent.personality = item.personality
    if (item.superior !== undefined) agent.superior = AgentV2.ID.make(item.superior)
    if (item.avatar !== undefined) agent.avatar = item.avatar
    if (item.memory !== undefined) agent.memory = item.memory
    if (item.archiveChats !== undefined) agent.archiveChats = item.archiveChats
    if (item.needsTier !== undefined) agent.needsTier = item.needsTier
    if (item.description !== undefined) agent.description = item.description
    if (item.directory !== undefined) agent.directory = item.directory
    // The standing work choices. Mapped onto the RECORD as well as read from the store by
    // `SessionEffectiveConfig`: the store is what a headless turn resolves through, the record is
    // what the config dialog renders — and a dialog that cannot show the current value is the same
    // defect `directory` had.
    if (item.permissionMode !== undefined) agent.permissionMode = item.permissionMode
    if (item.strict !== undefined) agent.strict = item.strict
    if (item.shortChat !== undefined) agent.shortChat = item.shortChat
    if (item.reground !== undefined) agent.reground = item.reground
    if (item.reasoningBudget !== undefined) agent.reasoningBudget = item.reasoningBudget
    if (item.mode !== undefined) agent.mode = item.mode
    if (item.hidden !== undefined) agent.hidden = item.hidden
    if (item.color !== undefined) agent.color = item.color
    if (item.steps !== undefined) agent.steps = item.steps
    if (item.permissions !== undefined) agent.permissions.push(...item.permissions)
  })
}
