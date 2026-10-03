import { Agent } from "@novaclaw/schema/agent"
import { Session } from "@novaclaw/schema/session"
import { SessionMessage } from "@novaclaw/schema/session-message"
import { InvalidRequestError } from "../errors"
import { Location } from "@novaclaw/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const AgentGroup = HttpApiGroup.make("server.agent")
  .add(
    HttpApiEndpoint.post("agent.reply", "/api/agent/owner/reply", {
      query: LocationQuery,
      payload: Schema.Struct({
        sessionID: Session.ID,
        messageID: SessionMessage.ID,
        replyID: SessionMessage.ID,
        text: Schema.String,
      }),
      success: Location.response(Schema.Struct({ sessionID: Session.ID })),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.agent.reply", summary: "Reply to an officer from your transcript" }),
    ),
  )
  .add(
    HttpApiEndpoint.get("agent.list", "/api/agent", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Agent.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.agent.list",
          summary: "List agents",
          description: "Retrieve currently registered agents.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("agent.teamChat", "/api/agent/:agentID/team-chat", {
      params: { agentID: Agent.ID },
      query: Schema.Struct({
        ...LocationQuery.fields,
        limit: Schema.optional(
          Schema.NumberFromString.check(
            Schema.isInt(),
            Schema.isGreaterThanOrEqualTo(1),
            Schema.isLessThanOrEqualTo(100),
          ),
        ),
        before: Schema.optional(Schema.String),
        after: Schema.optional(Schema.String),
      }),
      success: Location.response(Agent.TeamChatPage),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.agent.teamChat",
          summary: "Read an officer team's colleague chat",
          description:
            "Lists durable colleague-tool messages exchanged inside one officer's reporting tree, including messages between subordinates. Pages are bounded; use before to load older messages and after to follow the live tail.",
        }),
      ),
  )
  .add(
    /**
     * 🔴 THE COLLEAGUE'S OWN CHAT — the one identity question a client must not answer itself.
     *
     * A session is a component ON an agent (AGENTS.md), so "this colleague's chat" is the addressable
     * thing and the transcript id is an implementation detail that changes when the user clears the
     * chat. A client can derive it — the roster does — but the derivation runs over
     * `GET /api/session`, whose documented default is "the newest 50 sessions", so the answer is only
     * as complete as that page. A colleague whose current chat is older than the page is answered
     * with a different chat, or with nothing at all, and nothing is indistinguishable from "this
     * colleague has never had a chat".
     *
     * `RosterChat.chatFor` in the kernel answers this from SQL and is deliberately not shared across
     * the wire boundary. This is not that sharing — it is the instance answering, once, the one
     * question the client cannot answer correctly from what it already holds.
     */
    HttpApiEndpoint.get("agent.chat", "/api/agent/:agentID/chat", {
      params: { agentID: Agent.ID },
      query: LocationQuery,
      success: Location.response(Agent.Chat),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.agent.chat",
          summary: "A colleague's own chat",
          description:
            "Resolve the one live root chat belonging to this colleague, or 404 when it has never had one. " +
            "This is the agent-addressed form of the question every per-colleague surface needs — the " +
            "working dot, the badge, the transcript to open — answered from the database rather than " +
            "derived from a page of a session list. `directory` is where the chat actually runs, which " +
            "is not necessarily the colleague's configured folder.",
        }),
      ),
  )
  .add(
    /**
     * 🔴 EVERY root chat a colleague has — the set a "Clear chat" must take.
     *
     * The sibling of `/chat` above, and deliberately WIDER. `/chat` answers "which chat is this
     * colleague's now" and hides filed chats on purpose. A Clear needs the opposite: the transcript the
     * user is looking at is frequently an archived one, which is the recorded incident where clearing
     * reported nothing to do while the transcript stayed on screen.
     *
     * It exists because the client cannot assemble the set. It was folding `GET /api/session`, whose
     * documented default is the newest 50 sessions, so a colleague with more history than one page had a
     * Clear that removed part of it and reported success. A removal that reports success and leaves
     * transcripts behind is worse than one that fails.
     */
    HttpApiEndpoint.get("agent.chats", "/api/agent/:agentID/chats", {
      params: { agentID: Agent.ID },
      query: LocationQuery,
      success: Location.response(Schema.Array(Agent.ChatSummary)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.agent.chats",
          summary: "Every chat a colleague has",
          description:
            "All root chats belonging to this colleague, newest first, INCLUDING archived ones — the set " +
            '"Clear chat" must act on, since the transcript a user is reading is often a filed one. ' +
            "Sub-agent threads are not roots and are not included. An empty array means this colleague " +
            "has never had a chat.",
        }),
      ),
  )
  .add(
    /**
     * The portrait bytes owned by the instance. This is a raw endpoint because an image must remain
     * bytes all the way to the browser; putting it in the roster JSON would make every refresh carry
     * the same base64 payload and would make the model/UI identity split again.
     */
    HttpApiEndpoint.get("agent.avatar.get", "/api/agent/:agentID/avatar", {
      params: { agentID: Agent.ID },
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.agent.avatar.get",
        summary: "Read an agent portrait",
        description:
          "Read the instance-owned portrait bytes for one agent. An agent without an uploaded portrait " +
          "receives the deterministic server-owned placeholder.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("agent.avatar.upload", "/api/agent/:agentID/avatar", {
      params: { agentID: Agent.ID },
      /** The raw handler validates the media type and byte cap from the request headers/body. */
      payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      success: Schema.Struct({ hash: Schema.String, mime: Schema.String }),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.agent.avatar.upload",
        summary: "Upload an agent portrait",
        description:
          "Replace one agent's instance-owned portrait with bounded PNG, JPEG, GIF or WebP bytes. " +
          "The request must be authenticated and the bytes are stored under the instance data directory.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("agent.avatar.delete", "/api/agent/:agentID/avatar", {
      params: { agentID: Agent.ID },
      success: HttpApiSchema.NoContent,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.agent.avatar.delete",
        summary: "Delete an agent portrait",
        description: "Delete one agent's uploaded portrait and restore its server-owned placeholder or glyph.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("agent.usageMany", "/api/agent/usage", {
      payload: Schema.Struct({ agentIDs: Schema.Array(Agent.ID) }),
      query: LocationQuery,
      success: Location.response(Schema.Record(Schema.String, Schema.Array(Agent.UsageMinute))),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.agent.usageMany",
          summary: "Agents' per-minute output",
          description:
            "Tokens generated by the requested agents, bucketed by minute for the last 24 hours. " +
            "One response carries every requested agent; missing usage is an empty series.",
        }),
      ),
  )
  .add(
    // The roster's work column (owner, 2026-08-21): what this colleague PRODUCED, minute by minute.
    //
    // ⚠️ **The window is fixed at 24 hours and there are no query parameters**, matching the house
    // rule that no `/api/*` group declares `urlParams` (see `groups/log.ts`). It costs nothing to
    // return: the series is SPARSE — only minutes in which the colleague actually produced tokens
    // exist — so a day is at most 1440 rows and typically a handful. A caller showing a five-minute
    // rate slices what it needs; a caller showing a day already has it.
    HttpApiEndpoint.get("agent.usage", "/api/agent/:agentID/usage", {
      params: { agentID: Agent.ID },
      query: LocationQuery,
      success: Location.response(Schema.Array(Agent.UsageMinute)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.agent.usage",
          summary: "An agent's per-minute output",
          description:
            "Tokens this agent GENERATED (output + reasoning), bucketed by minute, newest first, for " +
            "the last 24 hours. Sparse on purpose: a minute in which the agent produced nothing has " +
            "no row at all, so an absent minute means nothing happened rather than 'measured, and it " +
            "was zero'. A sub-agent's output is attributed to the agent that owns it.",
        }),
      ),
  )
  .add(
    // Self-healing (AGENTS.md): a config-borne agent had NO delete path at all — `PATCH /config`
    // routes `agents` through `mergePatch`, which has no null-deletion, so an entry could be added
    // and merged but never removed. Idempotent by design (DELETE on a name with no stored row is a
    // 204), because the instance store is the sole configurable source of agent identity and
    // authority; there is no project-file definition left to remove separately.
    HttpApiEndpoint.delete("agent.remove", "/api/agent/:agentID", {
      params: { agentID: Agent.ID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      // 🔴 400 for the GOVERNING agent. This endpoint writes the store DIRECTLY, so the refusal in
      // `ConfigStoreWrite` does not cover it — one rule with two doors is one rule enforced at one
      // door. AGENTS.md, the structural metaphor: *"the charter is not editable from inside."*
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.agent.remove",
          summary: "Remove agent",
          description:
            "Delete a config-defined agent from the instance agent store, and clear `default_agent` when it pointed at that agent. Takes effect fully on the next serve boot. Nova and the instance owner cannot be removed and return 400.",
        }),
      ),
  )
  .add(
    /**
     * The coordination task board beside Team Chat: who is on this officer's team and what each is
     * working on. Answered from SQL by the instance because the membership (who shares this officer's
     * superior) is a kernel rule, not a fold over a page of sessions.
     */
    HttpApiEndpoint.get("agent.coordination", "/api/agent/:agentID/coordination", {
      params: { agentID: Agent.ID },
      query: LocationQuery,
      success: Location.response(Schema.Array(Agent.CoordinationEntry)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.agent.coordination",
          summary: "An officer team's coordination tasks",
          description:
            "The officer, its superior, its peers and its direct reports, each with the coordination " +
            "task it declared. Keyed on the AGENT, so a task survives a Clear chat and is re-read into " +
            "the prompt after every compaction.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "agents",
      description: "The colleagues this instance can run a session as: the roster, each one's work, and removal.",
    }),
  )
