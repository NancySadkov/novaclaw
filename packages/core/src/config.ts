export * as Config from "./config"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { ConfigAnnotation } from "@novaclaw/schema/config-annotation"
import { Permission } from "@novaclaw/schema/permission"
import { ResourcePressure } from "@novaclaw/schema/resource-pressure"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Location } from "./location"
import { Policy } from "./policy"
import { AbsolutePath } from "./schema"
import { ConfigAgent } from "./config/agent"
import { ConfigAttachments } from "./config/attachments"
import { ConfigCompaction } from "./config/compaction"
import { ConfigContext } from "./config/context"
import { ConfigCommand } from "./config/command"
import { ConfigCapabilityService } from "./config/capability-service"
import { ConfigDevice } from "./config/device"
import { ConfigExperimental } from "./config/experimental"
import { ConfigFormatter } from "./config/formatter"
import { ConfigAdhocTools } from "./config/adhoc-tools"
import { ConfigAffective } from "./config/affective"
import { ConfigHarnessDrives } from "./config/harness-drives"
import { ConfigIntrospection } from "./config/introspection"
import { ConfigLocalModelCatalog } from "./config/local-model-catalog"
import { ConfigLog } from "./config/log"
import { ConfigTrash } from "./config/trash"
import { ConfigMCP } from "./config/mcp"
import { ConfigPersona } from "./config/persona"
import { ConfigProvider } from "./config/provider"
import { ConfigProviderPreset } from "./config/provider-preset"
import { ConfigProviderConnection } from "./config/provider-connection"
import { ConfigReference } from "./config/reference"
import { ConfigServer } from "./config/server"
import { ConfigStrict } from "./config/strict"
import { ConfigToolOutput } from "./config/tool-output"
import { ConfigToolRouting } from "./config/tool-routing"
import { ConfigComputer } from "./config/computer"
import { ConfigWatcher } from "./config/watcher"
import { ConfigNudge } from "./config/nudge"
import { SettingsConfigSeed } from "./settings-config-seed"
import { SettingsConfigStore } from "./settings-config-store"
import { Log } from "@novaclaw/schema/log"

/**
 * ⚠️ **Every key below is also priced.** todo.md ruling 4 — *config writes are privilege-tiered:
 * operational · consequential · privileged, unclassified ⇒ privileged* — and the table that prices
 * them is `KEY_TIERS` in [`tool/configure.ts`](./tool/configure.ts), typed
 * `Record<keyof Config.Info, Tier>` so **a field added here does not compile until it is
 * classified there**. The annotations in this file carry the tier only where the answer is
 * surprising or lives in a third file; the table itself is the record.
 */
export class Info extends Schema.Class<Info>("Config.Info")({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.String.pipe(Schema.optional).annotate({
    description: "Default shell to use for terminal and shell tool execution",
  }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description: "Default model to use when no session or agent model is selected",
  }),
  default_agent: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Default primary agent to use when no session agent is selected. ⚠️ Ruling 4: PRIVILEGED — " +
      "selection is authorship here, because the chosen agent decides both the system prompt and the " +
      "permission ruleset every future session opens with.",
  }),
  username: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Username displayed in conversations and used for telemetry identity. ⚠️ Ruling 4: PRIVILEGED, " +
      "which is not obvious from the name — `tool/profile.ts` falls back to this string as the profile " +
      "NAME it hands the model, so it is free text that reaches a future session's context.",
  }),
  expertise: Schema.Literals(["normal", "advanced", "developer"]).pipe(Schema.optional).annotate({
    description:
      "The user's expertise level, mirrored from the UI (uix.md §6) so the model can meet them there — 'normal' adds a plain-language system hint",
  }),
  server: ConfigServer.Info.pipe(Schema.optional).annotate({
    description: "Server configuration for `novaclaw serve` and web commands (port/hostname/mDNS/CORS)",
  }),
  permissions: Permission.Ruleset.pipe(Schema.optional).annotate({
    description: "Ordered tool permission rules applied to agent tool use",
  }),
  agents: Schema.Record(Schema.String, ConfigAgent.Info).pipe(Schema.optional).annotate({
    description: "Named built-in agent overrides and custom agent definitions",
  }),
  snapshots: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable snapshots used for undo and revert behavior",
  }),
  watcher: ConfigWatcher.Info.pipe(Schema.optional).annotate({
    description: "Filesystem watcher configuration",
  }),
  computer: ConfigComputer.Info.pipe(Schema.optional).annotate({
    description: "Computer-use display binding (the `computer` tool declines when unset)",
  }),
  formatter: ConfigFormatter.Info.pipe(Schema.optional).annotate({
    description: "Enable built-in formatters or configure formatter overrides",
  }),
  attachments: ConfigAttachments.Info.pipe(Schema.optional).annotate({
    description: "Attachment processing configuration",
  }),
  log: ConfigLog.Info.pipe(Schema.optional).annotate({
    description: "Runtime-editable, instance-owned local activity-log settings",
  }),
  trash: ConfigTrash.Info.pipe(Schema.optional).annotate({
    description: "Runtime-editable safe-delete retention shown in Settings → Storage",
  }),
  tool_output: ConfigToolOutput.Info.pipe(Schema.optional).annotate({
    description: "Tool output truncation thresholds",
  }),
  tool_routing: ConfigToolRouting.Info.pipe(Schema.optional).annotate({
    description:
      "Ordered per-model tool horizon rules. Mode/provider/model selectors match a turn; later boolean tool decisions win. Routing only withdraws or restores earlier routing choices and never overrides permissions",
  }),
  resource_pressure: ResourcePressure.Info.pipe(Schema.optional).annotate({
    description:
      "Memory and disk headroom thresholds (warning + floor). Defaults live beside the probe in " +
      "storage/pressure.ts, so a host that never sets this still gets a real line; overrides apply " +
      "per field. ⚠️ Ruling 4: CONSEQUENTIAL, never operational — an agent that can lower its own " +
      "floor has exempted itself from the guard.",
  }),
  nudges: ConfigNudge.List.pipe(Schema.optional).annotate({
    description:
      "Targeted user-authored harness instructions. Defaults ship in code; a stored array replaces them and is evaluated live at event boundaries.",
  }),
  mcp: ConfigMCP.Info.pipe(Schema.optional).annotate({
    description: "MCP server configuration",
  }),
  compaction: ConfigCompaction.Info.pipe(Schema.optional).annotate({
    description: "Conversation compaction behavior",
  }),
  context: ConfigContext.Info.pipe(Schema.optional).annotate({
    description:
      "Typed context-window guard: live instance default plus per-session-type share ceilings and the bounded, periodic task-checklist reminder",
  }),
  provider_connection: ConfigProviderConnection.Info.pipe(Schema.optional).annotate({
    description:
      "Provider connection liveness limits. Runtime-editable so a working model can repair an endpoint-specific timeout without rebuilding or restarting NovaClaw",
  }),
  persona: ConfigPersona.Info.pipe(Schema.optional).annotate({
    description: "Persona baseline prepended to every agent's system prompt (B3)",
  }),
  user_profile: Schema.Struct({
    enabled: Schema.Boolean.pipe(Schema.optional).annotate({
      description:
        "When true, the assistant may look up this profile on demand via the `profile` tool (instead of it being absent). Off = the profile is not shared with the model (B4).",
    }),
    name: Schema.String.pipe(Schema.optional).annotate({ description: "The user's name" }),
    about: Schema.String.pipe(Schema.optional).annotate({
      description: "Background / 'about me' the assistant should know (role, expertise, preferences)",
    }),
  })
    .pipe(Schema.optional)
    .annotate({
      description:
        "User profile the model can read (name + background). Delivered on demand through the `profile` tool when enabled (B4)",
    }),
  introspection: ConfigIntrospection.Info.pipe(Schema.optional).annotate({
    description: "Introspection mode — a judge model periodically checks whether the session is stuck (P2)",
  }),
  harness_drives: ConfigHarnessDrives.Info.pipe(Schema.optional).annotate({
    description:
      "The automatic continuations applied to a turn that thinks it is finished (re-grounding, set completion, " +
      "fan-out supervision). All default ON; switching one off exists so the model can be measured unaided",
  }),
  adhoc_tools: ConfigAdhocTools.Info.pipe(Schema.optional).annotate({
    description: "Ad-hoc tool recipes: name + description listed in the system prompt, manual pulled on demand (P4)",
  }),
  affective: ConfigAffective.Info.pipe(Schema.optional).annotate({
    description: "Affective mode — emotion-modulated sampling + loop-breaking nudges (P3)",
  }),
  strict: ConfigStrict.Info.pipe(Schema.optional).annotate({
    description:
      "Strict mode — the Juvenile Harness posture for weak/local models: harness-owned decomposition, per-step verification, recovery (jh.md; E6)",
  }),
  instances: Schema.Array(
    Schema.Struct({
      name: Schema.String.annotate({ description: "Peer name (also keys the NOVACLAW_INSTANCE_<NAME>_* env vars)" }),
      url: Schema.String.annotate({ description: "The peer's base URL, e.g. http://127.0.0.1:4097" }),
      // Ruling 5: a peer token is ACCOUNT-EQUIVALENT — the same class as `server.password`, so it
      // carries the same schema marker rather than relying on being spelled "token".
      token: ConfigAnnotation.secret(
        Schema.String.pipe(Schema.optional).annotate({
          description: "The peer's incoming API token (its server.password)",
        }),
      ),
    }),
  )
    .pipe(Schema.optional)
    .annotate({
      description:
        "P2P: peer NovaClaw instances this instance's AGENTS may drive over HTTP (full API access — sessions, registry, config). Surfaced to models as env vars in bash plus a system-prompt line.",
    }),
  folder_bookmarks: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description:
      "User-pinned folder bookmarks shown in the directory picker's rail (absolute paths on the " +
      "instance host). Instance-wide, exported with config, and agent-editable via PATCH /config " +
      "(self-healing: an agent can add/fix pins; the array replaces wholesale per the patch contract). " +
      "⚠️ Ruling 4: OPERATIONAL — one of only five keys an agent may write with no consent card. " +
      "Verified 2026-07-31: the only consumers are the directory picker and the Files app, so a pin " +
      "is presentation and grants no access.",
  }),
  virtualFs: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "FS-3: force the app-private virtual filesystem root (phones/sandboxes without a browsable FS); the NOVACLAW_VIRTUAL_FS env flag also enables it",
  }),
  offline: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Offline/airgap mode (OFF-A): outbound HTTP restricted to loopback + configured provider hosts, fail-closed. GLOBAL config only — the chokepoint is machine-level",
  }),
  // Dependability P6 / batch item 3.2: the telemetry CONSENT field. This is one of the TWO
  // independent conditions the upload path consults — the other is the live offline/airgap policy,
  // which force-disables telemetry regardless of this value (AGENTS.md design-principle 4). The
  // path itself is `observability/telemetry.ts`; it carries only `egress: true` attributes and a
  // crash SIGNATURE (error kind, a hash of the frames, OS, release line), never user content, and
  // it refuses with a named reason — `no_endpoint` — until a collector is configured, which is the
  // state on every machine today. ⚠️ Do not fold the airgap condition into this field's default:
  // the two are held apart on purpose and `telemetry.test.ts` fails if either starts reading the
  // other's source.
  /**
   * 🔴 The community P2P module is OFF until the user turns it on, and `consented` is why it stays
   * that way rather than defaulting on for convenience.
   *
   * Two fields, held apart for the same reason `telemetry.enabled` and `offline` are: they answer
   * different questions and folding them loses one of the answers.
   *
   *   · `consented` — has this person been shown what joining costs them, and said yes. STICKY: it
   *     records that a warning was read, and turning the module off later does not un-read it.
   *   · `enabled` — the switch in the Community app's settings. Off is a normal, reversible state.
   *
   * The module runs only when BOTH are true, and the airgap independently forces it off — the same
   * override telemetry has (design-principle 4). ⚠️ `consented: false` with `enabled: true` must
   * never run: that combination means somebody edited the config by hand to skip the warning.
   *
   * What the warning has to say is not decoration, and is recorded here because the fields exist to
   * carry its answer: the network is UNMODERATED (nobody can delete what a stranger writes, and it
   * may be offensive), and because there is no central server, talking to a peer reveals this
   * machine's IP ADDRESS to them. Both are consequences of the architecture, not defects in it.
   */
  community: Schema.Struct({
    consented: Schema.Boolean.pipe(Schema.optional).annotate({
      description:
        "The user has read the community warning (unmoderated content; direct connections reveal your IP) and accepted it. Absent means never asked — the module stays off and the app shows the warning.",
    }),
    enabled: Schema.Boolean.pipe(Schema.optional).annotate({
      description:
        "The Community app's on/off switch. Requires `consented`; airgap/offline mode forces it off independently.",
    }),
    /**
     * 🔴 Where the DEFAULT door looks — and the ability to shut it.
     *
     * Joining asks DNS for a first address so somebody who knows nobody still reaches the network.
     * That query tells whoever runs that zone that this machine runs NovaClaw, which is a small
     * thing and not nothing, and the vision's whole objection to a company in the middle applies to
     * us as much as anyone. So it is declared, pointable elsewhere, and refusable.
     *
     * ⚠️ Turning it off does NOT strand anybody: LAN discovery needs no seed, peer exchange
     * needs one address from any source, and typing a doorman's address always works. That is what
     * makes this a preference rather than a switch that breaks the product.
     */
    seeds: Schema.Struct({
      enabled: Schema.Boolean.pipe(Schema.optional).annotate({
        description:
          "Ask DNS for a starting address when joining. Nothing is asked unless you set `host` below — NovaClaw ships no zone of its own. With it off, this instance finds peers on the LAN, from addresses you type, through peer exchange and through the public directory.",
      }),
      host: Schema.String.pipe(Schema.optional).annotate({
        description:
          "The name whose TXT records list starting addresses. Absent by default and there is no project zone to fall back to: point it at a zone YOU control to bootstrap your own hosts. We run no seed list — that is the whole reason there is nothing to seize.",
      }),
    })
      .pipe(Schema.optional)
      .annotate({
        description: "The default way in for somebody who knows nobody. A convenience — never the only door.",
      }),
    /**
     * 🔴 ANSWERING strangers' questions — a THIRD condition, and narrower than the two above.
     *
     * Joining costs bandwidth and reveals an IP; answering costs TOKENS, which is a different order
     * of consent and so gets its own switch rather than riding on `enabled`.
     *
     * ⚠️ Declared here because it was NOT, and the failure was total and silent: the config
     * PATCH succeeded, the value was STRIPPED by this schema, and the gate read a key that could
     * never be stored — so the whole capability was unreachable in production while every test
     * passed. Found by turning it on against a live instance and watching nothing change.
     */
    answers: Schema.Struct({
      enabled: Schema.Boolean.pipe(Schema.optional).annotate({
        description:
          "Answer questions from other instances. OFF by default and separate from `enabled`: this is the one path that spends the user's tokens on people they have never met.",
      }),
      perDay: Schema.Finite.pipe(Schema.optional).annotate({
        description: "How many questions a day this instance will answer in total. Bounded before anything is spent.",
      }),
      perPeerPerDay: Schema.Finite.pipe(Schema.optional).annotate({
        description: "How many of the day's answers any ONE peer may take, so a single asker cannot consume it.",
      }),
      maxTokens: Schema.Finite.pipe(Schema.optional).annotate({
        description:
          "Token ceiling for one answer. A reasoning model spends this on thinking before it writes, so too small a value returns an EMPTY answer rather than a short one. Exposure is perDay times this.",
      }),
    })
      .pipe(Schema.optional)
      .annotate({
        description: "Answering peers' questions: off unless turned on, and bounded by a daily and a per-asker count.",
      }),
    /**
     * 🔴 PUBLISHING this instance's address to the public DHT — a FOURTH decision, and the
     * strongest of them.
     *
     * Joining reveals this machine's IP to peers it talks to; answering spends tokens; this puts an
     * address in a public directory that anyone can read without ever talking to us. The vision
     * accepts being findable as the price of true p2p, and says so on the consent screen — but that
     * is about being enumerable once you are IN the network, not about volunteering to be its front
     * door. So it gets its own key, off by default.
     *
     * 🔴 NEVER INFERRED. An instance cannot know its own external address: what it can see are
     * interfaces, and a machine behind a NAT sees private ones. Publishing a guess is publishing a
     * promise nobody can keep — measured 2026-08-17, when a perfectly reachable host advertised
     * loopback and a docker bridge because it trusted interface enumeration. The user knows which
     * address they forwarded; nothing else does.
     *
     * ⚠️ Absent is the ordinary state and costs nothing: an unreachable instance DIALS OUT, so it
     * never needed to be found. Whoever sets this carries the front door for everybody else.
     */
    announce: Schema.String.pipe(Schema.optional).annotate({
      description:
        "The address other instances can knock on, as host:port, published to the public DHT so strangers can find this one. Absent (the default) means this instance looks for peers but never advertises itself. Set it only if this address really reaches you from the internet — a wrong one publishes a door nobody can open.",
    }),
    /**
     * 🔴 WHERE THE DHT STARTS — runtime-editable, because the self-healing law says so.
     *
     * All three bootstrap addresses were compiled into the Rust sidecar under one operator's
     * hostname (Codex review P2). If those peers move, are blocked or change protocol, no agent
     * inside the OS can repair the instance: the binary has to be replaced. AGENTS.md's rule is
     * explicit — *every operational fact an outage could hinge on (provider endpoint URLs, model
     * entries, presets, instance settings) must live in runtime-editable stores behind the HTTP
     * config surface* — and a bootstrap list is exactly such a fact. It also made "we borrow a
     * commons rather than becoming one" less true of the boot path than of the design.
     *
     * ⚠️ Defaults still ship in code, and a store override WINS. That is the shape the law asks
     * for: a lay user whose bootstrap operator vanished asks any working model to point the
     * instance somewhere else, and it takes effect on the sidecar's next start — no rebuild, no
     * reinstall.
     *
     * ⚠️ Setting it to an EMPTY LIST is meaningful and allowed: it means "do not dial anyone
     * automatically", which is the airgap-adjacent choice for somebody who wants the DHT to work
     * only from peers they name. Absent means "use the shipped defaults".
     */
    dht: Schema.Struct({
      bootstrap: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
        description:
          "libp2p multiaddrs the DHT sidecar dials at startup, e.g. /dnsaddr/bootstrap.libp2p.io/p2p/Qm… . Absent uses the addresses shipped with this build; an empty list dials nobody automatically. Point it at operators you trust if the defaults stop working — no reinstall needed.",
      }),
    })
      .pipe(Schema.optional)
      .annotate({
        description:
          "Public-DHT operations. The bootstrap list is here so an agent can repair discovery through PATCH /config instead of the binary being replaced.",
      }),
  })
    .pipe(Schema.optional)
    .annotate({
      description:
        "Community P2P participation. Off until explicitly accepted — joining is a decision with consequences the user has to see first.",
    }),

  telemetry: Schema.Struct({
    endpoint: Schema.String.pipe(Schema.optional).annotate({
      description: "Crash-intake URL override; leave empty to use the NovaClaw maintenance endpoint",
    }),
    enabled: ConfigAnnotation.depends(
      Schema.Boolean.pipe(Schema.optional).annotate({
        description: "Allow crash telemetry uploads (default: true; offline/airgap mode forces off independently)",
      }),
      [
        {
          path: ["offline"],
          when: "unset",
          effect:
            "airgap mode force-disables telemetry and this consent flag does not override it — an explicit " +
            "true still refuses. Airgap OVERRIDES consent, it does not withdraw it",
          source: "packages/core/src/observability/telemetry.ts resolveGate",
        },
      ],
    ),
  })
    .pipe(Schema.optional)
    .annotate({
      description:
        "Telemetry consent and maintenance intake — gates crash signatures only, never user content; the endpoint is replaceable at runtime",
    }),
  memory: Schema.Struct({
    enabled: Schema.Boolean.pipe(Schema.optional).annotate({
      description:
        "Remember things across chats (graph memory / KB-G). Default ON; OFF = the runtime flows stand down (no auto-recall, auto-extraction, `kb` tool, or consolidation) — a privacy switch. The engine still needs the NOVACLAW_KB_MEMORY env to run at all",
    }),
    rerank: ConfigAnnotation.depends(
      Schema.Boolean.pipe(Schema.optional).annotate({
        description:
          "Let the MODEL order recalled memories (it reads the wording, so a definitive older statement can outrank a newer offhand musing — measured 4/4 vs 1/4 for metadata ordering). Costs one short call per turn (~0.4s at 5 candidates). Default ON; off = metadata ordering only",
      }),
      [
        {
          path: ["memory", "enabled"],
          when: "set",
          effect: "there is nothing to order — auto-recall does not run at all",
          source: "packages/core/src/config.ts (memory.enabled: 'OFF = the runtime flows stand down')",
        },
      ],
    ),
    embedding: ConfigAnnotation.depends(
      Schema.Struct({
        url: Schema.String.pipe(Schema.optional).annotate({
          description:
            "OpenAI-compatible embeddings base URL for the LAN embedding device (e.g. http://spark:8001/v1). Unset = keyword-only (FTS) memory search",
        }),
        model: ConfigAnnotation.depends(
          Schema.String.pipe(Schema.optional).annotate({
            description:
              "Embedding model id as served (e.g. qwen3-embedding). Its width must match the graph's vector column (1024)",
          }),
          [
            {
              path: ["memory", "embedding", "url"],
              when: "set",
              effect: "no embedding device is called, so the model id is never used",
              source: "packages/core/src/config.ts (embedding.url: 'Unset = keyword-only (FTS) memory search')",
            },
          ],
        ),
      })
        .pipe(Schema.optional)
        .annotate({
          description:
            "The memory VECTOR leg (measured: hybrid vector+FTS retrieval 85% vs keyword-only 77%). LAN-local, airgap-safe; unreachable = degrade to FTS, never fail",
        }),
      [
        {
          path: ["memory", "enabled"],
          when: "set",
          effect: "the memory flows stand down entirely, vector leg included",
          source: "packages/core/src/config.ts (memory.enabled: 'OFF = the runtime flows stand down')",
        },
      ],
    ),
  })
    .pipe(Schema.optional)
    .annotate({
      description: "Graph-memory (KB-G) privacy switch — the lay Memory on/off",
    }),
  quality: Schema.Struct({
    enabled: Schema.Boolean.pipe(Schema.optional),
    cadence: Schema.Finite.pipe(Schema.optional).annotate({
      description: "Run the whole-module typecheck every N writes (default 2)",
    }),
    testTimeout: Schema.Finite.pipe(Schema.optional).annotate({
      description: "Hard timeout for the test gate in ms (default 300000)",
    }),
    commands: Schema.Struct({
      syntax: Schema.String.pipe(Schema.optional).annotate({
        description: "Per-file syntax check ({file} placeholder)",
      }),
      check: Schema.String.pipe(Schema.optional).annotate({ description: "Per-file incremental verifier ({file})" }),
      typecheck: Schema.String.pipe(Schema.optional).annotate({ description: "Whole-module type/compile check" }),
      test: Schema.String.pipe(Schema.optional).annotate({ description: "Test-gate command" }),
      lint: Schema.String.pipe(Schema.optional).annotate({ description: "Structural/lint pass" }),
    }).pipe(Schema.optional),
  })
    .pipe(Schema.optional)
    .annotate({
      description:
        "Quality Enforcement mode (QE): provisioned check commands run at write/turn boundaries; failures steer the agent to fix and re-run — per-project override is first-class",
    }),
  web_search: Schema.Struct({
    searxngUrl: Schema.String.pipe(Schema.optional).annotate({
      description: "A SearXNG instance URL (e.g. http://localhost:8080). When set it REPLACES the built-in engines.",
    }),
    disabledEngines: ConfigAnnotation.depends(
      Schema.String.pipe(Schema.Array, Schema.optional).annotate({
        description:
          "Built-in engine ids to turn off (currently: duckduckgo, wikipedia) — for one that starts misbehaving.",
      }),
      [
        {
          path: ["web_search", "searxngUrl"],
          when: "unset",
          effect: "there are no built-in engines left to disable — SearXNG replaces the whole set",
          source: "packages/core/src/websearch/service.ts resolveEngines (searxngUrl returns before the filter)",
        },
      ],
    ),
    timeoutMs: Schema.Finite.pipe(Schema.optional).annotate({ description: "Per-engine timeout in ms (default 8000)" }),
    // The web traffic governor (core/web/fetch-pace.ts). Governs ALL outbound web reads — search AND
    // article fetches — not just search; it lives here because this is the user-facing home for web
    // access. ⚠️ Loosening these is how a runaway agent gets the USER'S ip banned: the defaults keep our
    // traffic in the range of a person reading articles, which is the whole basis for treating robots.txt
    // as informational rather than binding.
    throttle: Schema.Struct({
      hostIntervalMs: Schema.Finite.pipe(Schema.optional).annotate({
        description: "Sustained delay between reads of the SAME site, in ms (default 4000). Lower = more bot-like.",
      }),
      burst: Schema.Finite.pipe(Schema.optional).annotate({
        description:
          "Reads allowed back-to-back per site before the delay applies (default 3) — a person opening a few tabs.",
      }),
      perHostConcurrency: Schema.Finite.pipe(Schema.optional).annotate({
        description:
          "Simultaneous requests to ONE site (default 1). Above 1 is swarming and is the fastest way to get blocked.",
      }),
      dailyPerHost: Schema.Finite.pipe(Schema.optional).annotate({
        description: "Reads per site per UTC day (default 150) — a heavy human reader, far below mirroring a site.",
      }),
      sameUrlLimit: Schema.Finite.pipe(Schema.optional).annotate({
        description:
          "Refuse re-fetching one URL more than this many times per session (default 3) — the fetch-loop guard.",
      }),
    })
      .pipe(Schema.optional)
      .annotate({
        description:
          "Outbound web-read pacing + per-site daily caps. Defaults imitate a person reading; loosening them risks the user's IP being blocked.",
      }),
  })
    .pipe(Schema.optional)
    .annotate({
      description:
        "Web search: a power user's own SearXNG when set, else NovaClaw's built-in in-process meta-search (no setup, offline-gated). GLOBAL config only.",
    }),
  skills: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs to discover skills from",
  }),
  /**
   * Per-skill invocation choices — the HUMAN half of the two skill-invocation switches.
   *
   * ⚠️ **Only `show` lives here, and the other switch's absence is deliberate.** "Nova may choose
   * this" is the `skill` PERMISSION action and is written into `permissions` above, because that
   * one rule already does both halves of refusing it (drops the skill from `<available_skills>`
   * AND refuses the `skill` tool). A second copy of that decision here would be a gate that can
   * disagree with the gate. See `core/src/skill/invocation.ts` for the whole argument.
   *
   * Keyed by `SkillInvocation.identify`'s id — the skill's own name, verbatim, and only when the
   * name is well-formed enough to be written down. Sparse: an absent entry means the default (on).
   */
  skill_invocation: Schema.Record(
    Schema.String,
    Schema.Struct({
      show: Schema.Boolean.pipe(Schema.optional).annotate({
        description: "Whether this skill appears in your own slash-command list. Absent = yes.",
      }),
    }),
  )
    .pipe(Schema.optional)
    .annotate({
      description:
        "Per-skill invocation choices, keyed by skill name. Only covers YOUR slash list; whether the agent may choose a skill is the `skill` permission action.",
    }),
  /**
   * Which installed pre-action policies actually run — the policy-management half.
   *
   * ⚠️ **Sparse, and an absent entry means ON.** An installed policy runs because it was installed;
   * this key is how the person at the computer switches one OFF, and it is an override rather than
   * a doorway (principle 12a). Writing `enabled: true` is therefore the same as writing nothing.
   *
   * ⚠️ **It may never carry anything but a switch, and that is a type-level property.** A policy is
   * chosen by ID and its behaviour lives in code that was installed; if this struct could carry a
   * command, a pattern or a script, a config write would become a way to author a new pre-action
   * guard — which is precisely what `novaclaw.json`'s `policies` section is forbidden from doing
   * ("IDs of installed policies only — never a command"). The two surfaces name policies; neither
   * defines one.
   *
   * Keyed by `ProjectFile.POLICY_ID_PATTERN`'s grammar — the same ids a `novaclaw.json` may spell
   * and the same ids a provider may register under, so the three can always name each other.
   */
  tool_policy: Schema.Record(
    Schema.String,
    Schema.Struct({
      enabled: Schema.Boolean.pipe(Schema.optional).annotate({
        description: "Whether this installed pre-action policy runs. Absent = yes.",
      }),
    }),
  )
    .pipe(Schema.optional)
    .annotate({
      description:
        "Per-policy on/off choices for the installed pre-action policies, keyed by policy id. Absent = the policy runs. A folder's novaclaw.json may opt IN to an installed policy; only this key can switch one off.",
    }),
  commands: Schema.Record(Schema.String, ConfigCommand.Info).pipe(Schema.optional).annotate({
    description: "Named slash command definitions",
  }),
  instructions: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Additional paths or URLs supplying ambient instructions",
  }),
  references: ConfigReference.Info.pipe(Schema.optional).annotate({
    description: "Named local directories or Git repositories available as external context",
  }),
  // ⚠️ There is deliberately NO `plugins` key. Ruling 5 (`notes/reports/decisions-v0.2.0.md` §5,
  // executed as dependency step 17): outside code never runs in-process, so the arm that fetched a
  // package with `npm.add` and `import()`ed it is gone and the key that fed it went with it. MCP is
  // the out-of-process extension seam. What SURVIVES is the user's own `{plugin,plugins}/*.ts` files
  // dropped in a config directory — `config/plugin/external.ts` still walks for those — but they are
  // filesystem-discovered at user privilege, never nameable by an agent, a registry or a peer, which
  // is precisely why they are not a config key. Do not re-add one.
  experimental: ConfigExperimental.Experimental.pipe(Schema.optional).annotate({
    description:
      "Unstable settings, including `policies` — the provider allow/deny rules `catalog.ts` evaluates. " +
      "Nothing here carries a compatibility promise.",
  }),
  provider_presets: Schema.Record(Schema.String, ConfigProviderPreset.Info)
    .pipe(Schema.optional)
    .annotate({
      description:
        "Overrides/additions to the BUILT-IN provider import presets (Settings → Models → Add models). " +
        'Merged field-wise over the builtins by id — e.g. {"anthropic":{"baseURL":"https://…"}} repairs a ' +
        "moved vendor endpoint at RUNTIME (self-healing: any working model can PATCH /config with this key; " +
        "no config-file edits, no rebuild). Unknown ids add new presets; hidden:true hides one. " +
        "Already-imported providers are repaired via providers.<id>.api.url instead — presets shape future imports only. " +
        "⚠️ Ruling 4: CONSEQUENTIAL, and deliberately a tier below `providers` — a preset changes no LIVE " +
        "provider, so a hostile baseURL here still has to be picked up by a user-driven import that shows " +
        "the URL and asks for a key.",
    }),
  local_model_catalog: ConfigLocalModelCatalog.Info.pipe(Schema.optional).annotate({
    description:
      "Runtime repair overrides for managed local-model downloads. Built-in tested artifacts remain the defaults; " +
      "runtime/models URL and SHA-256 fields here win so an agent can repair a moved mirror or republished artifact " +
      "through PATCH /config without rebuilding NovaClaw. PRIVILEGED: these values select downloaded executable bytes.",
  }),
  // The DEVICE registry (v0.2.0 B2) — which endpoints share one model backend. See
  // `config/device.ts` for why this is declared rather than derived.
  // ⚠️ Ruling 4: OPERATIONAL, and the argument is the same one that made `MAX_BATCH` matter. This
  // key carries no URL the instance will ever call, no bytes it will execute and no text that
  // reaches a prompt: an endpoint listed here is only ever COMPARED against a model's own `api.url`,
  // and a device id is only ever a scheduler map key. The worst a hostile entry can do is group
  // unrelated backends, i.e. make turns queue behind one another — a throughput loss, recoverable by
  // deleting the entry, and strictly the safe direction of the two errors available (the other one
  // oversubscribes real hardware).
  /**
   * What the capability probe MEASURED about each model's tool channel, keyed `providerID/modelID`.
   *
   * 🔴 **Machine-written, and behind the config surface on purpose.** It is an operational fact an
   * outage hinges on — a model whose tool channel stopped working is a chat where the agent silently
   * cannot act — and AGENTS.md's self-healing law says every such fact belongs in a runtime-editable
   * store reachable over HTTP, not compiled in. So a still-working model can read this, see that the
   * verdict is stale or wrong, and repair it with one PATCH.
   *
   * ⚠️ It does NOT override the operator. `providers.<id>.models.<m>.request.body.toolChannel` still
   * wins; this is the measured fallback beneath it. The two are kept apart precisely so a re-test
   * cannot overwrite a deliberate decision.
   *
   * ⚠️ It had to be DECLARED here, not merely written. `SettingsConfigStore` validates its keys
   * against this type (`SETTINGS_KEYS satisfies keyof Config.Info`), and an undeclared key does not
   * fail the write — it fails the next BOOT, with "Configuration is invalid at sqlite-stores" and a
   * crash loop. Measured the hard way on 2026-08-13: one probe made the instance unbootable while
   * the whole test suite stayed green, because nothing in it boots a server with the row present.
   */
  /**
   * The per-request IMAGE CAP an endpoint enforces, keyed "providerID/modelID" — learned from the
   * endpoint's own 400 and kept so the next process does not have to re-learn it.
   *
   * 🔴 Why it is persisted at all (measured 2026-08-20). The cap lives in a per-process map, so a
   * fresh process spends its entire first turn not knowing it — and `read`'s withholding gate, the
   * mechanism that stops an undescribed image being evicted, cannot fire without it. A long-lived
   * server learns the cap once and is fine; a cold CLI run loses images on its first image-heavy
   * turn, every time.
   *
   * ⚠️ A LEARNED value, never a guess: absent means "no cap known", which lowers byte-identically to
   * an endpoint that never had one. We do not invent a number for a stranger's server.
   */
  provider_media_limit: Schema.Record(Schema.String, Schema.Finite)
    .pipe(Schema.optional)
    .annotate({
      description:
        'How many images each model accepts in one request, keyed "providerID/modelID" — e.g. ' +
        '{"spark-holo/holo3.1":3}. Learned from the endpoint\'s own refusal; absent means no cap ' +
        "is known and every image is sent.",
    }),

  /**
   * Bounded measurements for one exact provider wire route. The key is a serialized tuple of
   * provider, wire-model, endpoint, route and protocol, so two servers sharing one scheduler Device
   * never share tokenizer evidence. Machine-written observations remain visible and repairable
   * through the ordinary config surface; malformed rows are ignored by the runtime reader.
   */
  provider_route_profile: Schema.Record(
    Schema.String,
    Schema.Struct({
      promptRatios: Schema.Array(Schema.Finite),
      promptResidualRatios: Schema.Array(Schema.Finite).pipe(Schema.optional),
      imagePatchPixels: Schema.Finite.pipe(Schema.optional),
      prefixCacheRetentionTokens: Schema.Finite.pipe(Schema.optional),
      servedBy: Schema.String.pipe(Schema.optional),
    }),
  )
    .pipe(Schema.optional)
    .annotate({
      description:
        "Measured prompt-token ratios and model/server properties for an exact provider route. " +
        "Prompt samples are bounded to the newest eight; deleting an entry restores safe defaults.",
    }),

  provider_capability: Schema.Record(
    Schema.String,
    Schema.Struct({
      choice: Schema.Literals(["native", "prompted", "chat-only", "unknown"]),
      rationale: Schema.optional(Schema.String),
      measuredAt: Schema.Finite,
      fingerprint: Schema.String,
      // The endpoint it was measured from. Optional so a row written before this field is still a
      // valid measurement rather than a decode failure that re-measures for a display detail.
      endpoint: Schema.optional(Schema.String),
      /** The serving process that answered (`system_fingerprint`), when the endpoint reports one. */
      servedBy: Schema.optional(Schema.String),
    }),
  )
    .pipe(Schema.optional)
    .annotate({
      description:
        "What the endpoint-capability probe measured about each model's tool channel, keyed " +
        '"providerID/modelID" — e.g. {"spark-holo/holo3.1":{"choice":"native",…}}. Written by the ' +
        "probe, read when a model resolves, and beaten by an explicit " +
        "providers.<id>.models.<m>.request.body.toolChannel. `fingerprint` records what was measured " +
        "so a moved endpoint discards the verdict instead of acting on it.",
    }),
  devices: Schema.Record(Schema.String, ConfigDevice.Info)
    .pipe(Schema.optional)
    .annotate({
      description:
        "Model BACKENDS keyed by device id, each listing the endpoint origins it serves — e.g. " +
        '{"spark":{"endpoints":["http://192.168.178.40:8010","http://192.168.178.40:8011"]}} tells the ' +
        "scheduler those two servers are ONE box, so they share one admission gate and one fairness " +
        "ledger instead of handing out the batch cap twice for capacity that exists once. Unlisted " +
        "endpoints keep a per-origin device of their own. Purely a scheduling grouping: nothing here " +
        "is ever called, executed or put in a prompt.",
    }),
  // External service declarations are PRIVILEGED: HTTP entries choose an egress destination and
  // stdio entries choose executable bytes. Static outage facts live here; observed state belongs to
  // the resource governor and is never written back into operator intent.
  capability_services: Schema.Record(Schema.String, ConfigCapabilityService.Info)
    .pipe(Schema.optional)
    .annotate({
      description:
        "External capability services keyed by id. Each declaration names capabilities, MCP transport, " +
        "locality, supported types, protocol revision, limits, memory estimates, warmup/idle policy and " +
        "health timing. Live load/health state is observed by the governor, not stored here. PRIVILEGED: " +
        "HTTP URLs choose an egress destination and stdio commands choose executable bytes.",
    }),
  // ⚠️ Ruling 4: PRIVILEGED, and the reason is not the URL alone. Each nested model carries a
  // `prePrompt` that `config/provider.ts` describes as "prepended to the system context" — so this key
  // is a prompt-text channel as well as an endpoint, and it fails ruling 4's fourth test outright.
  providers: Schema.Record(Schema.String, ConfigProvider.Info)
    .pipe(Schema.optional)
    .annotate({
      description:
        "Installed providers keyed by id, each carrying its endpoint (`api`), default request headers/body " +
        "and its models. This is where a moved vendor endpoint is repaired at runtime. ⚠️ `api` is a union " +
        "tagged on `type`, so it takes a COMPLETE alternative — a bare {url} decodes in no mode at all.",
    }),
  // Models-primary: the flat successor to `providers` — a map
  // of models keyed by id, each with its OWN endpoint `url` + params + `tier`. Decoded in
  // PARALLEL with `providers` (both accepted) until P6 retires the nested path. Inert until the
  // P2 seed reads it; additive here so authored configs and the equivalence gate can use it.
  models: Schema.Record(Schema.String, ConfigProvider.ModelEntry).pipe(Schema.optional).annotate({
    description: "Models-primary flat model map (id → { url, params, tier, … }); successor to nested providers",
  }),
  // Transitional — dies with the models-primary data model (a model is just a URL; there is
  // no first-class provider entity). Promoted into V2 (F1d D2) because the Settings UI and the
  // `/provider` filter still read these by name today.
  // ⚠️ Ruling 4: both are CONSEQUENTIAL rather than operational, for one reason that has nothing to
  // do with execution or egress — either one can leave the instance with NO working model, and "as
  // long as at least one working model remains" is the self-healing law's own precondition. It is the
  // single outage `configure` could cause that `configure` could not then repair.
  disabled_providers: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Providers to disable that would otherwise load automatically",
  }),
}) {}

export class Document extends Schema.Class<Document>("Config.Document")({
  type: Schema.Literal("document"),
  path: Schema.String.pipe(Schema.optional),
  info: Info,
}) {}

export class Directory extends Schema.Class<Directory>("Config.Directory")({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
}) {}

export type Entry = Document | Directory

export function latest<K extends keyof Info>(entries: readonly Entry[], key: K): Info[K] | undefined {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .findLast((entry) => entry.info[key] !== undefined)?.info[key]
}

export interface Interface {
  /** Returns location config documents and supplemental directories from lowest to highest priority. */
  readonly entries: () => Effect.Effect<Entry[]>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/Config") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const policy = yield* Policy.Service

    // Config→SQLite 8c: jsonc is NOT a runtime config source. The one config DOCUMENT is
    // synthetic — projected from the instance-wide settings store on each `entries()` call;
    // the per-subsystem stores feed their own loaders directly. The directory walk-up
    // survives for non-authority filesystem resources (markdown commands, `skill(s)/` dirs,
    // plugin files). Agent identity and permissions never ride project directories. jsonc is read
    // exclusively by the boot-time import seeds (isEmpty-gated, server startup) and the explicit
    // Import button — import/export wire format, never resolution.
    const globalDirectory = AbsolutePath.make(global.config)
    const locationIsGlobal = path.resolve(location.directory) === path.resolve(global.config)
    const discovered = locationIsGlobal
      ? []
      : yield* fs
          .up({
            targets: [".novaclaw"],
            start: location.directory,
            stop: location.root,
          })
          .pipe(Effect.orDie)
    const directories: Entry[] = [
      new Directory({ type: "directory", path: globalDirectory }),
      ...discovered
        .filter((item) => path.basename(item) === ".novaclaw")
        .toReversed()
        .map((directory) => new Directory({ type: "directory", path: AbsolutePath.make(directory) })),
    ]

    const settingsStore = yield* SettingsConfigStore.Service

    /**
     * Read the store and project it into the synthetic settings document.
     *
     * One bad row must never silently revert every setting to its compiled default: the decode is
     * per-key, and whatever it could not apply is named in the same format the import seed uses.
     * Non-blocking by contract — a corrupt row degrades the config, it never fails the boot.
     *
     * ⚠️ The skipped notice is de-duplicated by CONTENT, not suppressed after the first emit. Now
     * that this runs per call, logging unconditionally would repeat the same warning on every turn;
     * logging only once would hide a row that goes bad later. Announce on change.
     */
    let lastSkippedNotice: string | undefined
    const readSettings = Effect.fn("Config.readSettings")(function* () {
      const settings = SettingsConfigSeed.settingsInfoFromStore(yield* settingsStore.all())
      const notice = settings.skipped.length > 0 ? SettingsConfigSeed.formatSkippedNotice(settings.skipped) : undefined
      if (notice !== undefined && notice !== lastSkippedNotice)
        yield* Log.event("config.settings.skipped", { "config.notice": notice })
      lastSkippedNotice = notice
      // Policies come from the store-backed synthetic document; the import seed preserved the
      // historical reversed-concat order, so loading them verbatim keeps rule precedence.
      yield* policy.load(settings.info?.experimental?.policies ? [...settings.info.experimental.policies] : [])
      return settings.info
    })

    // Loaded once at construction as well, so `Policy` is populated before anything can evaluate it.
    // `catalog.ts` is the only evaluator today (`provider.use`) and it guards on `hasStatements()`,
    // so a boot with no `entries()` call yet would allow every provider — a deny rule that has not
    // loaded is a deny rule that is not enforced. Cheap to keep: `Policy.load` is one assignment.
    yield* readSettings()

    return Service.of({
      // ⚠️ B7 tier-1 / ruling 3: read THROUGH to the store at the point of use — "a settings change
      // is not a reboot". This used to project the store ONCE at layer scope and hand back the same
      // frozen array forever, which is why AGENTS.md carried a "restart `serve` after config changes"
      // caveat and why `tool/bash.ts` grew its own live-store read to work around it. The store is a
      // single-table SELECT and no caller is per-token — the hottest are per-turn (`runner/llm.ts`)
      // and per-bash-call — so the cost is a query, not a rebuild.
      //
      // The DIRECTORY entries stay hoisted deliberately: they are a filesystem walk-up, i.e. the
      // shape of the tree rather than a runtime-editable value, so ruling 3 does not reach them and
      // re-walking per call would be real I/O for a result that cannot change without a new location.
      entries: Effect.fn("Config.entries")(function* () {
        const settingsInfo = yield* readSettings()
        return settingsInfo ? [...directories, new Document({ type: "document", info: settingsInfo })] : directories
      }),
    })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Policy.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, Location.node, Policy.node, SettingsConfigStore.node],
})
