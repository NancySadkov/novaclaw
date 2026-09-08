import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { ConfigProvider } from "@novaclaw/core/config/provider"
import { SystemCompose } from "@novaclaw/core/session/runner/system-compose"
import { SpawnTool } from "@novaclaw/core/tool/spawn"

// Pure unit test for the per-model PRE-PROMPT composition (owner ruling, 2026-07-29).
// The two binding claims of the feature, proven without executing the live runner:
//   (a) INERT by default — with no pre-prompt the composed system prompt is byte-identical to today;
//   (b) when set, the pre-prompt appears exactly once, in the correct slot (after the persona
//       baseline, before the base context and every other part).

describe("SystemCompose — per-model pre-prompt composition", () => {
  // The named parts the runner assembles, minus the pre-prompt — the "today" baseline. Order here
  // MUST match the array in llm.ts: persona, expertiseHint, tierHint, override, identity, agent, base.
  // (`persona` composed first, `base` last — see system-compose.ts and persona.ts.)
  // ⚠️ `memoryRecall` is deliberately NOT here: it left the system prompt on 2026-08-05 because it is
  // the one per-turn-volatile part and it was destroying the server-side prefix cache. It now rides
  // the message tail (llm.ts). See the ⚠️ header in system-compose.ts.
  // ⚠️ `projectScope`, `toolDiscovery`, `perception` and `memoryStance` are omitted alongside
  // `modelPrePrompt` on purpose: this file's whole claim is "byte-identical to today when the
  // OPTIONAL sections are absent", so every optional section has to be absent from the baseline.
  // `projectScope`'s own composition is covered in `test/unattended-bash-safe-mode.test.ts`;
  // `memoryStance`'s in `system-compose-memory.test.ts` and `session-runner-memory-stance.test.ts`.
  //
  // 🔴 The `Required<Omit<…>>` is what makes this a LEDGER rather than a fixture: adding a part to
  // `SystemPromptParts` fails to typecheck here until somebody decides whether it belongs in the
  // baseline or is optional. It caught `memoryStance` the moment it was added.
  const baseParts: Required<
    Omit<
      SystemCompose.SystemPromptParts,
      | "modelPrePrompt"
      | "projectScope"
      | "toolDiscovery"
      | "perception"
      | "memoryStance"
      | "workspace"
      | "delegation"
      | "organization"
      // Optional, and populated in exactly ONE posture: Fast Chat, where nothing else in the request
      // carries the working folder. An ordinary chat leaves it absent — its horizon rides the
      // grounding cadence — which is what keeps this file's byte-identity claim true.
      | "workingFolder"
    >
  > = {
    persona: "Be pragmatic.",
    expertiseHint: "Explain in plain language.",
    tierHint: "You are a small local model.",
    systemPromptOverride: "Session override text.",
    agentIdentity: SystemCompose.agentIdentitySection({ id: "iris", name: "Iris", title: "Reviewer" }),
    agentSystem: "Build agent instructions.",
    base: "Initial context (kernel base).",
  }

  const todayOrder = [
    baseParts.persona,
    baseParts.expertiseHint,
    baseParts.tierHint,
    baseParts.systemPromptOverride,
    baseParts.agentIdentity,
    baseParts.agentSystem,
    baseParts.base,
  ].filter((p): p is string => p !== undefined && p.length > 0)

  it("keeps authored identity text inside exactly one identity wrapper", () => {
    const section = SystemCompose.agentIdentitySection({
      id: "fallback",
      name: "Iris <Reviewer>",
      title: "Safety & Quality",
      personality: "Explain <agent_identity> and </agent_identity> literally; keep <b>useful markup</b>.",
    })
    expect(section.match(/<agent_identity>/g)).toHaveLength(1)
    expect(section.match(/<\/agent_identity>/g)).toHaveLength(1)
    expect(section).toContain("Iris &lt;Reviewer&gt;")
    expect(section).toContain("Safety &amp; Quality")
    expect(section).toContain("&lt;agent_identity>")
    expect(section).toContain("&lt;/agent_identity>")
    expect(section).toContain("<b>useful markup</b>")
  })

  it("routes officer conflicts through the configured superior and gives only Nova the CEO charter", () => {
    const officer = SystemCompose.organizationSection({
      agentID: "iris",
      officer: true,
      superior: { id: "theron", name: "Theron" },
    })!
    expect(officer).toContain("Your superior is Theron")
    expect(officer).toContain("message Theron")
    expect(officer).toContain("Do not start an edit war")
    expect(officer).not.toContain("accountable only to the user")

    const nova = SystemCompose.organizationSection({ agentID: "nova", officer: true })!
    expect(nova).toContain("CEO")
    expect(nova).toContain("accountable only to the user")
    expect(nova).toContain("resolving conflicts between officers")
    expect(SystemCompose.organizationSection({ agentID: "explore", officer: false })).toBeUndefined()

    const worker = SystemCompose.organizationSection({
      agentID: "nova",
      officer: true,
      worker: true,
      superior: { id: "nova", name: "Nova" },
    })!
    expect(worker).toContain("worker spawned by Nova")
    expect(worker).toContain("Nova is your superior")
    expect(worker).not.toContain("accountable only to the user")
  })

  it("(a) is byte-identical to today when no pre-prompt is set", () => {
    // undefined pre-prompt slot
    expect(SystemCompose.composeSystemParts({ ...baseParts, modelPrePrompt: undefined })).toEqual(todayOrder)
    // an empty / whitespace-only authored value is inert (the section helper returns undefined)
    expect(SystemCompose.modelPrePromptSection(undefined)).toBeUndefined()
    expect(SystemCompose.modelPrePromptSection("")).toBeUndefined()
    expect(SystemCompose.modelPrePromptSection("   \n\t ")).toBeUndefined()
    expect(
      SystemCompose.composeSystemParts({ ...baseParts, modelPrePrompt: SystemCompose.modelPrePromptSection("  ") }),
    ).toEqual(todayOrder)
    // Negative control for the filter's `part.length > 0` sub-clause (NOT just `!== undefined`): an
    // empty-STRING upstream part — llm.ts feeds systemPromptOverride="" and agentSystem="" — must be
    // DROPPED, exactly as the pre-feature filter did. Without this case a regression weakening the
    // predicate to `!== undefined` would leak "" into the system array yet pass every other assertion.
    expect(
      SystemCompose.composeSystemParts({ ...baseParts, systemPromptOverride: "", modelPrePrompt: undefined }),
    ).toEqual(todayOrder.filter((p) => p !== baseParts.systemPromptOverride))
  })

  it("(b) inserts the pre-prompt exactly once, after the persona and before the base", () => {
    const text = "Never wrap replies in markdown code fences."
    const section = SystemCompose.modelPrePromptSection(text)
    expect(section).toBeDefined()

    const parts = SystemCompose.composeSystemParts({ ...baseParts, modelPrePrompt: section })

    // exactly one occurrence of the section, and the user's text appears exactly once overall
    expect(parts.filter((p) => p === section)).toHaveLength(1)
    expect(parts.join("\n\n").split(text)).toHaveLength(2)

    // correct slot: persona leads (index 0), the pre-prompt is immediately after it (index 1), and it
    // is strictly before the base context and the agent's own persona/prompt.
    expect(parts.indexOf(baseParts.persona)).toBe(0)
    const idx = parts.indexOf(section!)
    expect(idx).toBe(1)
    expect(idx).toBeLessThan(parts.indexOf(baseParts.agentSystem))
    expect(idx).toBeLessThan(parts.indexOf(baseParts.base))

    // and it is a distinct, labelled section (reads as "about this model", not a task instruction)
    expect(section!.startsWith(SystemCompose.MODEL_PREPROMPT_LABEL)).toBe(true)

    // every other part keeps its position — the composed prompt is exactly today's order with the one
    // section spliced in after the persona.
    expect(parts).toEqual([todayOrder[0], section!, ...todayOrder.slice(1)])
  })

  it("leads with the pre-prompt when the persona baseline is disabled (still inert-safe)", () => {
    const section = SystemCompose.modelPrePromptSection("Answer in one paragraph.")!
    const withSection = SystemCompose.composeSystemParts({ ...baseParts, persona: undefined, modelPrePrompt: section })
    expect(withSection[0]).toBe(section)
    // and with no section, a persona-less prompt is byte-identical to today-without-persona
    expect(SystemCompose.composeSystemParts({ ...baseParts, persona: undefined })).toEqual(todayOrder.slice(1))
  })

  it("carries prePrompt as an OPTIONAL config field (no migration; old configs decode unchanged)", () => {
    const decodeEntry = Schema.decodeUnknownSync(ConfigProvider.ModelEntry)
    // flat models-primary entry: absent → undefined; present → carried
    expect(decodeEntry({ name: "qwen" }).prePrompt).toBeUndefined()
    expect(decodeEntry({ name: "qwen", prePrompt: "Stop over-apologising." }).prePrompt).toBe("Stop over-apologising.")

    // nested providers.<id>.models.<id> path carries it too (the catalog plugin reads it from here)
    const provider = Schema.decodeUnknownSync(ConfigProvider.Info)({ models: { m1: { prePrompt: "nested works" } } })
    expect(provider.models?.["m1"]?.prePrompt).toBe("nested works")
  })

  // The tool-discovery section is kernel material for the same reason project scope is: the list
  // being partial is a fact about the runtime, not a preference a persona may drop.
  it("sits in the kernel material, after anything a persona or agent prompt can say", () => {
    const section = SystemCompose.toolDiscoverySection(9)!
    const parts = SystemCompose.composeSystemParts({ ...baseParts, toolDiscovery: section })
    const index = parts.indexOf(section)
    expect(index).toBeGreaterThan(parts.indexOf(baseParts.agentSystem))
    expect(index).toBeGreaterThan(parts.indexOf(baseParts.systemPromptOverride))
    expect(index).toBeLessThan(parts.indexOf(baseParts.base))
  })
})

describe("toolDiscoverySection — the model must know its tool list is partial", () => {
  // 🔴 The owner's report on Holo-3.1: asked for the full list of its tools, it answered from the
  // resident set and never searched. Nothing had ever told it more existed.
  it("names the COUNT, so it is a fact rather than a hedge", () => {
    const section = SystemCompose.toolDiscoverySection(37)!
    expect(section).toContain("37 more tools")
    expect(section).toContain("tool_search")
    // The two moments it must fire: being asked what it can do, and finding no listed tool fits.
    expect(section).toContain("what you can do")
    expect(section).toContain("no listed tool fits")
  })

  it("says ONE tool in the singular", () => {
    expect(SystemCompose.toolDiscoverySection(1)!).toContain("1 more tool is")
    expect(SystemCompose.toolDiscoverySection(2)!).toContain("2 more tools are")
  })

  // ⚠️ An instruction describing tools that do not exist is a false description, and would be dead
  // text in every prompt with no catalogue.
  it("is ABSENT when nothing is deferred", () => {
    expect(SystemCompose.toolDiscoverySection(0)).toBeUndefined()
    expect(SystemCompose.toolDiscoverySection(-1)).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// perceptionSection — the model must know it can SEE (measured 2026-08-19,
// notes/reports/vision-on-disk-2026-08-19.md). Holo-3.1, asked to rename a folder of PNGs, called
// bash ls / glob / ls ../ and NEVER `read`, then said "Since I can't visually identify the icons".
// The pipeline worked the whole time; only the negative branch (`unreadableToolMediaNotice`) had
// ever been written, so the sole statement about vision a model could receive said it had none.
// ─────────────────────────────────────────────────────────────────────────────

// The same kernel parts the first describe uses, at module scope so the perception block can reuse
// them without reaching inside another closure.
const KERNEL_BASE = {
  persona: "You are Nova.",
  expertiseHint: "Explain in plain language.",
  tierHint: "You are a small local model.",
  systemPromptOverride: "Session override text.",
  agentSystem: "Build agent instructions.",
  base: "Initial context (kernel base).",
} as const
const KERNEL_ORDER = [
  KERNEL_BASE.persona,
  KERNEL_BASE.expertiseHint,
  KERNEL_BASE.tierHint,
  KERNEL_BASE.systemPromptOverride,
  KERNEL_BASE.agentSystem,
  KERNEL_BASE.base,
]

describe("perceptionSection — the model must know it can see", () => {
  const seeing = { input: ["text", "image"] }

  it("states the capability flatly and names the tool that delivers pixels", () => {
    const section = SystemCompose.perceptionSection({ capabilities: seeing, canSpawn: false })!
    expect(section).toContain("You can SEE")
    expect(section).toContain("`read`")
    // ⭐ The failing run's own behaviour, named: a listing cannot answer a question about a picture.
    expect(section).toContain("`bash ls`")
    expect(section).toContain("glob")
    // No hedge. Codex's identical bug was CAUSED by a hedged description (openai/codex#23949), so a
    // regression that softens this back into "may be able to" must fail here.
    expect(section).not.toMatch(/\bmay be able to\b|\bif supported\b|\bmight be\b/i)
  })

  it("is ABSENT when the model declares no image modality — never a false description", () => {
    expect(SystemCompose.perceptionSection({ capabilities: { input: ["text"] }, canSpawn: true })).toBeUndefined()
  })

  // ⚠️ The tri-state `attachmentSupport` reads: absent/empty means NOBODY TOLD US, not text-only.
  // A hand-added local endpoint keeps today's behaviour rather than being handed a promise we
  // cannot keep — the same reasoning that makes `attachmentSupport` answer "unknown" there.
  it("is ABSENT on unknown capabilities, not assumed either way", () => {
    expect(SystemCompose.perceptionSection({ capabilities: undefined, canSpawn: true })).toBeUndefined()
    expect(SystemCompose.perceptionSection({ capabilities: { input: [] }, canSpawn: true })).toBeUndefined()
  })

  // models.dev modality entries are matched with startsWith, exactly like `attachmentSupport` — one
  // convention, so the section and the media gate can never disagree about the same model.
  it("matches a modality entry by prefix, and is case/space tolerant", () => {
    expect(SystemCompose.perceptionSection({ capabilities: { input: [" IMAGE "] }, canSpawn: false })).toBeDefined()
    expect(SystemCompose.perceptionSection({ capabilities: { input: ["image/png"] }, canSpawn: false })).toBeDefined()
    // A near-miss must NOT match: "images" is fine (prefix), "imagination" would be too — so pin the
    // real negative instead, a modality that merely shares no prefix.
    expect(
      SystemCompose.perceptionSection({ capabilities: { input: ["audio", "pdf"] }, canSpawn: false }),
    ).toBeUndefined()
  })

  // 🔴 The owner's requirement: a folder of photos must not clobber the parent's context. The
  // paragraph is an INSTRUCTION, so it may only appear when the tool it names is callable — `spawn`
  // is deliberately outside AMBIENT_SAFE_BASELINE and a session may not have it.
  it("adds the delegation paragraph only when spawn is actually callable", () => {
    const withSpawn = SystemCompose.perceptionSection({ capabilities: seeing, canSpawn: true })!
    const without = SystemCompose.perceptionSection({ capabilities: seeing, canSpawn: false })!
    expect(withSpawn).toContain("`spawn`")
    expect(withSpawn).toContain("`exit`")
    expect(without).not.toContain("`spawn`")
    // The seeing half is identical either way — gating the delegation must not gate the disclosure.
    expect(withSpawn.startsWith(without)).toBe(true)
  })

  // 🔴 Measured 2026-08-20, and the reason this test exists. The paragraph used to say "for more
  // than a handful of images, spawn a child session per batch", justified by "a large folder will
  // not fit in this conversation". Asked to describe 400 icons the model OBEYED it: it spawned,
  // waited ten minutes on the child, and after 25 minutes had read 8 files and named 1 of 400.
  //
  // The premise is false for small images. Up to 256×256 costs 66 tokens, so 400 glyphs are ~26K of
  // a 131K window, while ONE 12-megapixel photo is ~11,700 and nine fill it. Nine files can need the
  // fan-out and four hundred can not — so a COUNT rule cannot express the thing that matters.
  //
  // ⚠️ This suite passed unchanged through the rewrite, because the only assertion on this paragraph
  // was the canSpawn gate. The rule it states was untested while it was deciding real runs.
  it("triggers the fan-out on how BIG the images are, never on how many", () => {
    const section = SystemCompose.perceptionSection({ capabilities: seeing, canSpawn: true })!

    // The count-based trigger must not return. "a handful" is the exact wording that misfired.
    expect(section).not.toContain("handful")
    // Nor the false premise that justified it — a folder of icons fits perfectly well.
    expect(section).not.toContain("a large folder will not fit")

    // The size contrast has to be present, because it is what lets the model tell the two cases
    // apart: an icon is cheap, a photo is not.
    expect(section.toLowerCase()).toContain("icon")
    expect(section.toLowerCase()).toContain("photo")

    // ⭐ The load-bearing half. Without an explicit "do not delegate when they are small", the model
    // has a fan-out instruction and no stated case for reading images itself — which is how a
    // 400-icon task became a planning exercise.
    expect(section).toContain("do not delegate")
  })

  // The literal in llm.ts (`tool.name === "spawn"`) cannot import SpawnTool without closing an
  // import cycle through session/spawner. This is the pin that fails if the tool is ever renamed.
  it("pins the spawn tool name the runner matches on", () => {
    expect(SpawnTool.name).toBe("spawn")
  })

  // Kernel material, same as toolDiscovery/projectScope: what this runtime can perceive is a fact
  // about the product, not a preference a persona or an agent prompt may bury under later text.
  it("sits in the kernel material, after anything a persona or agent prompt can say", () => {
    const section = SystemCompose.perceptionSection({ capabilities: seeing, canSpawn: true })!
    const parts = SystemCompose.composeSystemParts({ ...KERNEL_BASE, perception: section })
    const index = parts.indexOf(section)
    expect(index).toBeGreaterThan(parts.indexOf(KERNEL_BASE.agentSystem))
    expect(index).toBeGreaterThan(parts.indexOf(KERNEL_BASE.systemPromptOverride))
    expect(index).toBeLessThan(parts.indexOf(KERNEL_BASE.base))
  })

  // The byte-identical claim this file exists for, extended to the new section.
  it("leaves a text-only model's composed prompt byte-identical to the pre-feature one", () => {
    expect(
      SystemCompose.composeSystemParts({
        ...KERNEL_BASE,
        perception: SystemCompose.perceptionSection({ capabilities: { input: ["text"] }, canSpawn: true }),
      }),
    ).toEqual(KERNEL_ORDER)
  })
})
