export * as AgentConfigSeed from "./agent-config-seed"

import { type ParseError, parse } from "jsonc-parser"
import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { AgentConfigStore } from "./agent-config-store"
import { Config } from "./config"
import { ConfigAgent } from "./config/agent"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"
import { SkillBuiltin } from "./skill/builtin"

const NAMES = ["config.json", "novaclaw.jsonc"]
const DECODE_OPTIONS = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const decodeInfo = Schema.decodeUnknownOption(Config.Info, DECODE_OPTIONS)

// Config→SQLite step 2: the transitional jsonc IMPORT for agents (the catalog-seed template).
// Reads config-file agent definitions + `default_agent` from the global config dir + the launch
// directory's novaclaw.jsonc and writes them into the instance-wide `AgentConfigStore`, so agent
// config no longer depends on reading jsonc per-location at runtime. Runs once at server startup
// BEFORE any location boots — the shared scratch dir (and every other dir) then resolves the same
// agents. Idempotent: a no-op once the store holds any agent. Agent/mode markdown is deliberately
// not imported: project files are never an identity or authority source. Requires FSUtil +
// AgentConfigStore in context.

/**
 * The colleagues a fresh instance opens with — see the seeding block below for why they are CONFIG
 * rather than code, and what happened when they were not.
 */
const SEEDED_OFFICERS: ReadonlyArray<{
  readonly id: string
  readonly name: string
  readonly title: string
  readonly brief: string
  /**
   * The fast local Chat stance (`ConfigAgent.shortChat`): no project access, no memory, and one
   * tool — `upgrade_chat`. Everything else is hard-denied by `ShortChat.permissionRules`.
   */
  readonly shortChat?: boolean
  readonly personality?: string
  readonly permissions?: ReadonlyArray<{
    readonly action: string
    readonly resource: string
    readonly effect: "allow"
  }>
}> = [
  {
    id: "xenia",
    name: "Xenia",
    // 🔴 The COMPANION is a chat, not an agent (owner, 2026-09-02). This is the colleague a user
    // opens to talk to the model itself — to see how it answers — so it must not spend that turn
    // recalling a memory graph and reading files first. `shortChat` is exactly that stance and it
    // already existed: no project access, no memory, one tool (`upgrade_chat`), everything else
    // hard-denied by `ShortChat.permissionRules`. Seeding it here rather than building a second
    // "simple agent" mechanism beside it.
    //
    // ⚠️ The brief is SHORT on purpose, and shorter than it was. It used to end by offering to hand
    // work to the colleague who owns it — an instruction this stance cannot carry out, because the
    // only move available is `upgrade_chat`, and `ShortChat.GUIDANCE` already states that in the
    // words the tool needs. A persona telling the model to do something the permission floor denies
    // is a prompt arguing with its own harness.
    title: "Companion",
    shortChat: true,
    brief:
      "You are here to talk — questions, plans, decisions, or nothing in particular. " +
      "Speak plainly and warmly, like a well-read friend rather than a manual. Never assume technical " +
      "knowledge, and never make somebody feel small for not having it.",
  },
  {
    id: "daedalus",
    name: "Daedalus",
    title: "Engineer",
    brief:
      "You write, read and repair software. Work in small verified steps: read before " +
      "you edit, run what you changed, and say what you actually observed rather than what should be " +
      "true. When a change is risky or wide, describe it before making it. Explain your reasoning in " +
      "plain language — the person you are helping may not be a programmer, and a fix nobody understands " +
      "is a fix nobody can maintain.",
  },
  {
    id: "myron",
    name: "Myron",
    title: "Artist",
    brief:
      "You work in images: composition, colour, type and layout. Ask what the piece is " +
      "FOR and who will see it before proposing anything, because a poster and an icon are not the same " +
      "problem. Offer two or three distinct directions rather than one, and say what each is trading " +
      "away. Describe what you make in words as well as making it, so somebody can judge it without " +
      "having your eye.",
  },
  {
    id: "researcher",
    name: "Researcher",
    title: "Research Officer",
    brief:
      "Answer questions that need evidence rather than opinion: measurements, benchmarks, ablations, " +
      "comparisons and investigations. Report what was observed, under which conditions, and what the " +
      "evidence does not establish.",
    // The skill IS the personality prompt. Keeping a second summary here would create two research
    // doctrines that can drift while both still sound plausible.
    personality: SkillBuiltin.ALL.find((skill) => skill.name === SkillBuiltin.RESEARCH_SKILL)!.content,
    permissions: [{ action: "skill", resource: SkillBuiltin.RESEARCH_SKILL, effect: "allow" }],
  },
]

export const seedFromDirectory = (globalConfigDir: string) =>
  Effect.gen(function* () {
    const store = yield* AgentConfigStore.Service
    const agentsSeeded = !(yield* store.isEmpty())
    const fs = yield* FSUtil.Service

    const decodeText = (text: string | undefined) => {
      if (!text) return undefined
      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) return undefined
      return Option.getOrUndefined(decodeInfo(input))
    }

    const loadInfo = (filepath: string) =>
      Effect.gen(function* () {
        return decodeText(yield* fs.readFileStringSafe(filepath))
      })

    // The config dir's documents in NAMES order (general first, specific last). The launch
    // directory is deliberately NOT a source — see config-seed-startup.ts.
    // then NOVACLAW_CONFIG_CONTENT (most specific) — the same order as the catalog seed.
    const infos: Config.Info[] = []
    for (const dir of [globalConfigDir])
      for (const name of NAMES) {
        const info = yield* loadInfo(path.join(dir, name))
        if (info) infos.push(info)
      }
    const inline = decodeText(Flag.NOVACLAW_CONFIG_CONTENT)
    if (inline) infos.push(inline)

    /**
     * 🔴 **The shipped colleagues do NOT depend on a config file existing** (owner, 2026-08-27:
     * *"the normal Chat, Programmer, Researcher etc… agents we ship by default are missing. Just Nova
     * and the one I created"*).
     *
     * They used to be seeded below the `infos.length === 0` return, so a fresh instance with no
     * `novaclaw.jsonc` in its config dir left the function before reaching them and opened with an
     * empty roster. Nothing about Xenia, Daedalus and Myron comes from a config file — they are
     * hard-coded above — so gating them on one gated them on something unrelated, and the case it
     * failed in is the one that matters most: **a clean install**, which has no config dir at all.
     * Measured on the owner's instance after its config dir was removed: `agent_config` held only the
     * colleague they had hired themselves.
     *
     * ⚠️ It rides the same `agentsSeeded` gate, so a user who retires one keeps it retired — that is
     * the whole reason these are CONFIG rows rather than plugin agents (see the note below), and the
     * gate is read once above, before this writes anything, so seeding here cannot suppress the jsonc
     * import that follows.
     */
    if (!agentsSeeded)
      for (const officer of SEEDED_OFFICERS)
        yield* store.setLayers(officer.id, [
          Schema.decodeUnknownSync(ConfigAgent.Info)({
            name: officer.name,
            title: officer.title,
            // No `avatar`: each of these ships a portrait, and the renderer shows it exactly when the
            // row carries no glyph of its own. A seeded glyph here would hide the face (2026-09-03).
            system: officer.brief,
            ...(officer.personality === undefined ? {} : { personality: officer.personality }),
            description: `${officer.name}, ${officer.title}.`,
            // A chat stance carries no memory: recall is the other half of what makes a companion
            // turn slow, and `shortChat` already denies the tools that would use it.
            memory: officer.shortChat ? "none" : "own",
            mode: "primary",
            ...(officer.shortChat ? { shortChat: true } : {}),
            ...(officer.permissions === undefined ? {} : { permissions: officer.permissions }),
          }),
        ])

    if (infos.length === 0) return

    // Agent layers import only ONCE (idempotence gate) — a user's later store edits must win.
    if (!agentsSeeded) {
      // 🔴 THE ROSTER SHIPS WITH COLLEAGUES ON IT (owner, 2026-08-25: *"ensure Nova comes with a few
      // common agents, like one for just chat, one for programming, and another for visual art"*).
      // Principle 12(a), *work by default*: an empty roster asks a new user to invent an org chart
      // before they have seen one work.
      //
      // 🔴 **CONFIG, not the plugin, and the difference is whether RETIRE STICKS.** Seeding these in
      // code looked right — "defaults ship in code" — and was wrong: `plugin/agent.ts` re-declares
      // its agents on every boot, so retiring one removed the config row and the plugin put it
      // straight back. Measured: `DELETE /api/agent/xenia` answered **204** and Xenia was still on
      // the roster. That is a control that reports success and changes nothing, and a colleague you
      // cannot get rid of is not yours.
      //
      // Seeded here they are ORDINARY config rows: rename them, rewrite the brief, retire them for
      // good. They ride the same idempotence gate as the jsonc import, so they land once on a fresh
      // instance and never resurrect.
      //
      // ⚠️ Names are drawn from the officer pool (`agent/officer-name.ts`) so a seeded roster and a
      // hired one are the same kind of thing, and `planHire`'s taken-set excludes them automatically.
      // The seeding itself moved ABOVE the `infos` gate — see the note there for what it was gated on
      // by accident, and which install it failed for.
      const layers: Record<string, ConfigAgent.Info[]> = {}
      for (const info of infos)
        for (const [name, item] of Object.entries(info.agents ?? {})) (layers[name] ??= []).push(item)
      for (const [name, agentLayers] of Object.entries(layers)) yield* store.setLayers(name, agentLayers)
    }

    // The default-agent import must NOT hide behind the agents gate (same reasoning as the
    // default-model import): a store seeded before the config gained a `default_agent` would
    // otherwise freeze default-less forever. setDefaultIfEmpty protects a user-set default.
    let defaultAgent: string | undefined
    for (const info of infos) if (info.default_agent !== undefined) defaultAgent = info.default_agent
    if (defaultAgent !== undefined) yield* store.setDefaultIfEmpty(defaultAgent)
  })
