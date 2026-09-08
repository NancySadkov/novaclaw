import { AgentV2 } from "@novaclaw/core/agent"
import { FSUtil } from "@novaclaw/core/fs-util"
import { sessionErrorLike, sessionErrorLines } from "@novaclaw/core/session/session-error"
import { incompleteMessage, type IncompleteReason } from "./run/incomplete"
// CLI entry point for `novaclaw run` — the headless, non-interactive runner.
//
// Sends a single prompt, streams the session's events to stdout, and exits when
// the session goes idle. The prompt is delivered via the async `promptAsync`
// endpoint (the V2/V1 router), so the process blocks on the idle event from the
// event stream rather than on a synchronous response body. With `--attach` it
// drives a running novaclaw server; otherwise it runs an in-process one.
//
// Also supports `--command` for slash-command execution (still the blocking
// legacy endpoint — there is no async variant), `--format json` for raw event
// streaming, `--continue` / `--session` for session resumption, and `--fork`
// for forking before continuing.
import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { open } from "node:fs/promises"
import { Effect } from "effect"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { CommandSpec } from "../command-spec"
import { EOL } from "os"
import { Filesystem } from "@/util/filesystem"
import { createNovaclawClient, type NovaclawClient } from "@novaclaw/sdk/v2"
import type { ToolPart } from "./run/types"
import { resolveRunRoot } from "./run/root"
import { FormatError, FormatUnknownError } from "../error"

type ModelInput = string

function pick(value: string | undefined): ModelInput | undefined {
  // The native switch takes the "providerID/modelID" ref string apart itself at the call site.
  return value || undefined
}

function resolveRunInput(value?: string, piped?: string): string | undefined {
  if (!value) {
    return piped
  }

  if (!piped) {
    return value
  }

  return value + "\n" + piped
}

// Read piped stdin for the prompt. A non-TTY stdin held OPEN but silent — CI wrappers and
// process runners that spawn with a pipe and never write or close it — parks
// `Bun.stdin.text()` forever waiting for EOF, hanging the whole run before any output
// (the test harness works around it with stdin:"ignore"; real callers hit it). When a
// message argument already exists, stdin is OPTIONAL extra input: give a real pipe a
// short grace window (an actual `echo x | novaclaw run "y"` delivers EOF well within it)
// and proceed without stdin if nothing arrives. With no message argument, stdin is the
// only input source — block until EOF as before.
const PIPED_INPUT_GRACE_MS = 250

async function readPipedInput(hasMessage: boolean): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined
  const read = Bun.stdin.text()
  if (!hasMessage) return read
  return Promise.race([
    read,
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), PIPED_INPUT_GRACE_MS)
      timer.unref?.()
    }),
  ])
}

type FilePart = {
  type: "file"
  url: string
  /** Where the bytes CAME FROM. `url` inlines small files as a `data:` URI, which erases the fact
   *  that they are a file on the user's disk — and that fact is what stops the agent overwriting
   *  their own source without asking. Always set; `url` is the provider-facing payload, this is
   *  the local identity. */
  sourceUrl: string
  filename: string
  mime: string
}

const ATTACH_FILE_MAX_BYTES = 10 * 1024 * 1024

/**
 * The image MIME a file's own BYTES declare, or `undefined` when they declare none.
 *
 * ⚠️ Magic bytes, never the extension — a standing constraint, and the defect
 * class that fills Claude Code's tracker. `FSUtil.mimeType` is `mime-types.lookup`, i.e. the
 * extension, so `screenshot.txt` holding a PNG would be announced as text and rejected, while a
 * `.png` holding anything at all would be announced as an image and rejected at the provider.
 *
 * Scoped deliberately to the four types the image pipeline accepts (`tool/read.ts`'s
 * SUPPORTED_IMAGE_MIMES): this decides whether bytes ride as a PICTURE, and guessing outside that
 * set buys nothing. Everything else keeps the existing text-or-extension answer.
 */
const sniffImageMime = (bytes: Buffer): string | undefined => {
  const starts = (...magic: number[]) => magic.every((byte, index) => bytes[index] === byte)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png"
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg"
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif"
  // RIFF....WEBP — the four-byte size sits between the two tags, so both are checked.
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp"
  return undefined
}

type Inline = {
  icon: string
  title: string
  description?: string
}

type SessionInfo = {
  id: string
  title?: string
  directory?: string
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function formatRunError(error: unknown) {
  return FormatError(error) ?? FormatUnknownError(error)
}

async function tool(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    if (next.mode === "block") {
      block(next, next.body)
      return
    }

    inline(next)
  } catch {
    inline({
      icon: "\u2699",
      title: part.tool,
    })
  }
}

async function toolError(part: ToolPart) {
  try {
    const { toolInlineInfo } = await import("./run/tool")
    const next = toolInlineInfo(part)
    inline({
      icon: "✗",
      title: `${next.title} failed`,
      ...(next.description && { description: next.description }),
    })
    return
  } catch {
    inline({
      icon: "✗",
      title: `${part.tool} failed`,
    })
  }
}

export const RunCommand = effectCmd({
  ...CommandSpec.run,
  // --attach connects to a remote server (no local instance needed); the
  // default path runs an in-process server and needs the project instance.
  instance: (args) => !args.attach,
  // For --dir without --attach, load instance for the resolved target dir.
  // The handler also chdirs (preserving the legacy order: chdir → file resolution).
  directory: (args) => (args.dir && !args.attach ? path.resolve(process.cwd(), args.dir) : process.cwd()),
  builder: (yargs: Argv) =>
    yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running novaclaw server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password for --attach (defaults to NOVACLAW_SERVER_PASSWORD)",
      })
      .option("username", {
        alias: ["u"],
        type: "string",
        describe: "basic auth username for --attach (defaults to NOVACLAW_SERVER_USERNAME or 'novaclaw')",
      })
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (requires --model unless running --command)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        describe: "REMOVED — it cannot work; configure the agent's permissions and use --agent instead",
        default: false,
      }),
  handler: Effect.fn("Cli.run")(function* (args) {
    const { Agent } = yield* Effect.promise(() => import("@/agent/agent"))
    const { RuntimeFlags } = yield* Effect.promise(() => import("@/effect/runtime-flags"))
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { ServerAuth } = yield* Effect.promise(() => import("@/server/auth"))
    const agentSvc = yield* Agent.Service
    const flags = yield* RuntimeFlags.Service
    const localInstance = yield* InstanceRef
    // 🔴 `--dangerously-skip-permissions` REFUSES rather than warning (2026-08-23).
    //
    // It has been inert since `bf39088eb` removed the `permission.v2.asked` event it answers, so a
    // user passing it was refused exactly as if they had not. An earlier pass made it WARN; that was
    // half the rule. Principle 13's shape is **refuses-and-reports** — a surface must not accept a
    // line its reader discards — and warning still accepts it, then runs the whole task under a
    // belief about permissions that is false. Failing at the first line, naming the fix, is strictly
    // kinder than a run that looks approved and is not.
    //
    // 🔴 **It is not being reimplemented, and that is principle 1 rather than reluctance.** Granting
    // would mean inventing a run-scoped widening mechanism that exists nowhere else, purely to serve
    // V1 vocabulary — the flag answers a consent prompt the product deliberately deleted (principle
    // 14: no blocking waits for an absent human). The clean model already works: configure that
    // agent's permissions and select it with `--agent`. Keeping the flag alive would be the
    // back-compat shim principle 1 tells us to accept a breaking change over.
    //
    // ⚠️ And it could never have been honoured under `--attach` in any case: that drives a REMOTE
    // instance where a grant would widen a shared instance for everyone on it and outlive the run.
    if (args["dangerously-skip-permissions"]) {
      UI.error(
        "--dangerously-skip-permissions has been removed: the consent prompt it answered no longer " +
          "exists, so it silently granted nothing. Grant what this run needs in the agent's " +
          "permission settings and select it with --agent <name>.",
      )
      process.exit(2)
    }
    if (args.variant && !args.model && !args.command) {
      UI.error("--variant requires --model unless --command is used; no model was selected")
      process.exit(2)
    }
    if (!args.attach && (args.password !== undefined || args.username !== undefined)) {
      UI.error("--username and --password apply only with --attach")
      process.exit(2)
    }

    const local = args.attach
      ? undefined
      : yield* Effect.promise(() => import("@/server/routes/instance/httpapi/server")).pipe(
          Effect.flatMap(({ HttpApiApp }) => HttpApiApp.buildWebHandler),
        )
    // 🔴 **Everything below runs in plain `async`, OUTSIDE the Effect fiber — so a fresh
    // `Effect.runPromise` in there starts with DEFAULT fiber references and silently loses
    // `References.MinimumLogLevel`.** Symptom when it is not captured: `NOVACLAW_LOG_LEVEL=DEBUG`
    // does nothing on this path, and only on this path — a debug line three lines ABOVE the
    // boundary still appears.
    //
    // ⚠️ Capturing the CONTEXT is the fix rather than passing the level explicitly: references live in
    // the context, so this restores everything the boundary drops, not just the one that was noticed.
    // Anything served through `HttpApiApp`'s own layer is unaffected — that graph provides
    // `Observability.layer` itself.
    const captured = yield* Effect.context<never>()
    yield* Effect.promise(async () => {
      const thinking = args.thinking ?? false

      // Wall-clock watchdog: a one-shot run that wedges mid-turn (observed live — a stuck
      // await keeps the process alive indefinitely at ~1.5 GB, the OTHER half of the
      // issues.md P2 orphan generator) becomes a bounded failure instead of an immortal
      // orphan. Generous default; NOVACLAW_RUN_WALL_MS overrides for long agentic runs.
      const wallMs = Number(process.env["NOVACLAW_RUN_WALL_MS"]) || 45 * 60 * 1000
      const watchdog = setTimeout(() => {
        UI.error(`run exceeded its wall clock (${Math.round(wallMs / 60000)}m) — exiting`)
        process.exit(124)
      }, wallMs)
      // unref: the watchdog must never be the thing KEEPING the process alive.
      if (typeof watchdog === "object" && "unref" in watchdog) watchdog.unref()

      /**
       * 🔴 **THE PROMPT IS WHAT THE USER TYPED — byte for byte.**
       *
       * The shell already removed the quotes: `novaclaw run "write a haiku"` arrives as a yargs
       * `array` positional holding ONE element, `write a haiku`. Re-adding `"` around any element
       * containing a space (and backslash-escaping the quotes inside it) therefore did not preserve
       * the user's text, it EDITED it — the model received `"write a haiku"`, quote characters and
       * all, while a single-word prompt was delivered verbatim. One command, two encodings, decided
       * by whether the text happens to contain a space.
       *
       * ⚠️ The quoting is not wrong everywhere, which is why it survived: `--command` hands its
       * argument string to a slash command that RE-SPLITS it, so there the quoting is what keeps a
       * multi-word argument together. It belongs on that path and only that path — hence two
       * strings from one argv, and `commandArguments` is read at exactly one call site.
       */
      const words = [...args.message, ...(args["--"] || [])]
      let message = words.join(" ")
      let commandArguments = words.map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(" ")

      /**
       * Who a headless run belongs to. `DEFAULT_COLLEAGUE_ID`, not the string "nova": the kernel
       * already names an owner for an unattributed request — *"exactly the case the CEO exists to
       * absorb"* — and a literal here would be a second answer to a question that has one.
       */
      const RUN_AGENT = AgentV2.DEFAULT_COLLEAGUE_ID
      const root = resolveRunRoot()
      const directory = (() => {
        if (!args.dir) return args.attach ? undefined : root
        if (args.attach) return args.dir

        try {
          process.chdir(path.isAbsolute(args.dir) ? args.dir : path.join(root, args.dir))
          return process.cwd()
        } catch {
          UI.error("Failed to change directory to " + args.dir)
          process.exit(1)
        }
      })()
      const attachHeaders = args.attach
        ? ServerAuth.headers({ password: args.password, username: args.username })
        : undefined
      const attachSDK = (dir?: string) => {
        return createNovaclawClient({
          baseUrl: args.attach!,
          directory: dir,
          headers: attachHeaders,
        })
      }

      const files: FilePart[] = []
      if (args.file) {
        const list = Array.isArray(args.file) ? args.file : [args.file]

        for (const filePath of list) {
          const resolvedPath = path.resolve(args.attach ? root : (directory ?? root), filePath)
          if (!(await Filesystem.exists(resolvedPath))) {
            UI.error(`File not found: ${filePath}`)
            process.exit(1)
          }

          const stat = Filesystem.stat(resolvedPath)
          const isDirectory = stat?.isDirectory() ?? false
          if (args.attach && isDirectory) {
            UI.error(`Cannot attach local directory without a shared filesystem: ${filePath}`)
            process.exit(1)
          }

          const content = await (async () => {
            // 🔴 **LOCAL and REMOTE both inline the bytes as a `data:` URI. There is no arm that
            // sends a bare `file://` URL.** Nothing downstream materializes a path:
            // `to-llm-message`'s `attachment()` decodes only `data:` URIs, and the messenger — the
            // only other producer of attachments — inlines for the same reason. A `file://` URL
            // therefore dies at the provider boundary, and not only for images: the text arm needs
            // a `data:` URI to decode and falls through to media when it cannot.
            //
            // Reading is the same work the remote arm already did, under the same 10 MiB cap, and a
            // directory still takes the branch below rather than being slurped.
            if (isDirectory) return
            const handle = await open(resolvedPath, "r")
            try {
              const opened = await handle.stat()
              if (!opened.isFile() || Number(opened.size) > ATTACH_FILE_MAX_BYTES) {
                UI.error(`Cannot attach local file larger than 10 MiB or a special file: ${filePath}`)
                process.exit(1)
              }
              if (opened.size === 0) return Buffer.alloc(0)
              const buffer = Buffer.alloc(Number(opened.size))
              let offset = 0
              while (offset < buffer.length) {
                const read = await handle.read(buffer, offset, buffer.length - offset, offset)
                if (read.bytesRead === 0) break
                offset += read.bytesRead
              }
              return buffer.subarray(0, offset)
            } finally {
              await handle.close()
            }
          })()
          const detected = await FSUtil.mimeType(resolvedPath)
          const text = content?.toString("utf8")
          // ⚠️ The local arm used to force `text/plain` for every file, so even once the bytes were
          // read a PNG would have been announced as text and rejected as an unsupported media type.
          // One rule now serves both arms: a directory is a directory, bytes that round-trip as
          // UTF-8 are text, and anything else is what the file actually IS.
          const mime = isDirectory
            ? "application/x-directory"
            : ((content && sniffImageMime(content)) ??
              (content && text !== undefined && Buffer.from(text, "utf8").equals(content) ? "text/plain" : detected))

          files.push({
            type: "file",
            url: content ? `data:${mime};base64,${content.toString("base64")}` : pathToFileURL(resolvedPath).href,
            sourceUrl: pathToFileURL(resolvedPath).href,
            filename: path.basename(resolvedPath),
            mime,
          })
        }
      }

      const piped = await readPipedInput(message.trim().length > 0)
      message = resolveRunInput(message, piped) ?? ""
      // Piped stdin joins BOTH strings the same way — it is the user's own bytes on either path,
      // and appending it raw is what `--command` already did before the two were separated.
      commandArguments = resolveRunInput(commandArguments, piped) ?? ""

      if (message.trim().length === 0 && !args.command) {
        UI.error("You must provide a message or a command")
        process.exit(1)
      }

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exit(1)
      }

      function title() {
        if (args.title === undefined) return
        if (args.title !== "") return args.title
        return message.slice(0, 50) + (message.length > 50 ? "..." : "")
      }

      async function session(sdk: NovaclawClient): Promise<SessionInfo | undefined> {
        if (args.session) {
          const current = await sdk.v2.session
            .get({
              sessionID: args.session,
            })
            .catch(() => undefined)

          if (!current?.data?.data) {
            UI.error("Session not found")
            process.exit(1)
          }

          if (args.fork) {
            const forked = await sdk.v2.session.fork({
              sessionID: args.session,
            })
            const id = forked.data?.data?.id
            if (!id) {
              return
            }

            return {
              id,
              title: forked.data?.data?.title ?? current.data.data.title,
              directory: forked.data?.data?.location.directory ?? current.data.data.location.directory,
            }
          }

          return {
            id: current.data.data.id,
            title: current.data.data.title,
            directory: current.data.data.location.directory,
          }
        }

        const base = args.continue
          ? (await sdk.v2.session.list()).data?.data?.find((item) => !item.parentID)
          : undefined

        if (base && args.fork) {
          const forked = await sdk.v2.session.fork({
            sessionID: base.id,
          })
          const id = forked.data?.data?.id
          if (!id) {
            return
          }

          return {
            id,
            title: forked.data?.data?.title ?? base.title,
            directory: forked.data?.data?.location.directory ?? base.location.directory,
          }
        }

        if (base) {
          return {
            id: base.id,
            title: base.title,
            directory: base.location.directory,
          }
        }

        const name = title()
        // ⚠️ No `permission` here any more. The CLI used to send three DENY rules (`question`,
        // `plan_enter`, `plan_exit`) into a field the evaluator never reads — and they were dead
        // three times over: the field is unread, the rules were in the LEGACY
        // `{permission, pattern, action}` shape while the evaluator takes `{action, resource, effect}`,
        // and `question` has not been a permission since the tool was deleted. `plan_enter`/
        // `plan_exit` are already denied by default in `plugin/agent.ts`, so nothing is lost.
        /**
         * 🔴 **A run belongs to NOVA, as one of her sub-sessions** (owner, 2026-08-28: *"no
         * ghosthouse architecture"*). This used to create a root with no agent at all — a chat owned
         * by nobody, on no roster, which is precisely the ghost `DEFAULT_COLLEAGUE_ID` names an owner
         * for: *"an unattributed request is exactly the case the CEO exists to absorb."*
         *
         * ⚠️ A CHILD, and that is the whole reason the parent call comes first. `novaclaw run` is a
         * one-shot task and people run many; as a ROOT with an agent it would resolve to Nova's one
         * chat and every run would pile into the conversation the user has with her. As a sub-session
         * each run is its own thread under an owner who can be pointed at.
         */
        /**
         * 🔴 **The run is Nova's SUB-SESSION, in the directory the user ran it from** (NC-CS-002).
         *
         * ⚠️ **`location` is not optional decoration — omitting it is what made this "hang".** A
         * session created with an agent and no location inherits that COLLEAGUE's folder, so this
         * one landed in `…/scratch/nova` while the CLI listened in the directory it was invoked
         * from. Session events are routed by location (see `session/execution/local.ts`: *"an
         * unstamped event loses its directory routing"*), so none of them ever reached the
         * subscriber. Measured 2026-08-28: the turn RAN — messages 1 → 3, the title changed — while
         * the CLI sat waiting and was killed at 30 s.
         *
         * ⚠️ So the note that stood here was wrong about the cause, and the earlier attempt was
         * abandoned for the wrong reason. There is no defect in "how a turn resolves an explicit
         * agent"; there was a missing location on a session that had been given somebody else's
         * folder. Pinning it is also the correct product behaviour on its own terms — `novaclaw run`
         * in a project directory works THERE, not in a colleague's scratch.
         *
         * ⚠️ A CHILD, not a root. With an agent and no parent the kernel resolves the canonical
         * `ses_<agent>`, so every one-shot run would pile into the single chat the user has with
         * Nova. The parent create is idempotent — it hands back the existing live root — so this
         * costs one round trip and makes each run its own thread under an owner who can be pointed
         * at.
         *
         * ⚠️ `test/cli/run/run-process.test.ts` is NOT in the fast gate. It lives under
         * `test/cli/`, which no promoted unit scans (`novaclaw:server` runs `test/server/` and
         * nothing else), so it executes only under `--full`. Run it by name after touching this.
         */
        const where = { directory: (directory ?? root) as never }
        const parent = await sdk.v2.session.create({ agent: RUN_AGENT, location: where })
        const parentID = parent.data?.data?.id
        const result = await sdk.v2.session.create({ title: name, agent: RUN_AGENT, parentID, location: where })
        const id = result.data?.data?.id
        if (!id) {
          return
        }

        return {
          id,
          title: result.data?.data?.title ?? name,
          directory: result.data?.data?.location.directory,
        }
      }

      async function current(sdk: NovaclawClient): Promise<string> {
        if (!args.attach) {
          return directory ?? root
        }

        const next = await sdk.path
          .get()
          .then((x) => x.data?.directory)
          .catch(() => undefined)
        if (next) {
          return next
        }

        UI.error("Failed to resolve remote directory")
        process.exit(1)
      }

      /**
       * 🔴 **AN UNRESOLVABLE `--agent` FAILS THE RUN.** Same rule, same reasoning as the refused
       * switch further down (`"A run that silently did the work as the wrong agent is worse than
       * one that did not run: its output looks authoritative."`) — it was written there and applied
       * only there. A misspelled name, a name that turns out to be a SUBAGENT, or a remote whose
       * agent list cannot be fetched used to print a warning into stderr traffic nobody reads, run
       * the whole task as whoever owns the session — **without the named colleague's MCP grants or
       * permissions** — and exit **0**. Every script and rig downstream reads that as a successful
       * run by the agent it asked for.
       *
       * ⚠️ `undefined` still means *the user named nobody*, which is the ordinary case and stays a
       * silent default. What may never be silent is a name that was given and could not be honoured.
       *
       * ⚠️ Both resolvers spell their return type out because their guards now END in
       * `process.exit`: it is that annotation which lets a `never`-returning call narrow what
       * follows it, the same reason `session()` above carries one.
       */
      async function localAgent(): Promise<string | undefined> {
        if (!args.agent) return undefined
        const name = args.agent

        // `Effect.provide(captured)` — see the boundary note above. Without it this run begins with
        // default references and anything it logs at debug is dropped.
        const entry = await Effect.runPromise(
          agentSvc.get(name).pipe(Effect.provideService(InstanceRef, localInstance), Effect.provide(captured)),
        )
        if (!entry) {
          UI.error(`could not run as agent "${name}": no agent by that name`)
          process.exit(1)
        }
        if (entry.mode === "subagent") {
          UI.error(`could not run as agent "${name}": it is a subagent, not a primary agent`)
          process.exit(1)
        }
        return name
      }

      async function attachAgent(sdk: NovaclawClient): Promise<string | undefined> {
        if (!args.agent) return undefined
        const name = args.agent

        const modes = await sdk.app
          .agents(undefined, { throwOnError: true })
          .then((x) => x.data ?? [])
          .catch(() => undefined)

        // ⚠️ A remote that cannot be asked is not a remote that answered "no such agent" — but it is
        // equally not permission to run as somebody else. Report which of the two happened, and stop.
        if (!modes) {
          UI.error(`could not run as agent "${name}": failed to list agents from ${args.attach}`)
          process.exit(1)
        }

        const agent = modes.find((a) => a.name === name)
        if (!agent) {
          UI.error(`could not run as agent "${name}": no agent by that name`)
          process.exit(1)
        }

        if (agent.mode === "subagent") {
          UI.error(`could not run as agent "${name}": it is a subagent, not a primary agent`)
          process.exit(1)
        }

        return name
      }

      async function pickAgent(sdk: NovaclawClient) {
        if (!args.agent) return undefined
        if (args.attach) {
          return attachAgent(sdk)
        }

        return localAgent()
      }

      /**
       * The requested colleague, resolved ONCE.
       *
       * ⚠️ Memoised because resolving it costs a round trip (a store read locally, an
       * `/app/agents` call under `--attach`) and because it REFUSES the run when the named agent
       * cannot be honoured — one decision must report itself once, not once per caller.
       */
      let agentChoice: Promise<string | undefined> | undefined
      const chosenAgent = (sdk: NovaclawClient) => (agentChoice ??= pickAgent(sdk))

      /**
       * 🔴 **The client must follow the SESSION, not the process.** A resumed run works in the
       * session's stored directory; an sdk bound to the process's own directory subscribes to the
       * wrong scope, and the failure is silent — the turn executes perfectly and the CLI receives
       * exactly one event (`server.connected`), then waits to be killed.
       *
       * ⚠️ LOCAL and ATTACH must take the SAME rebind. The asymmetry survived once because the
       * exercised path was the working one; do not fix one and leave the other.
       */
      async function execute(sdk: NovaclawClient, rebind: (dir: string) => NovaclawClient) {
        const sess = await session(sdk)
        if (!sess?.id) {
          UI.error("Session not found")
          process.exit(1)
        }
        const sessionID = sess.id

        function emit(type: string, data: Record<string, unknown>) {
          if (args.format === "json") {
            process.stdout.write(
              JSON.stringify({
                type,
                timestamp: Date.now(),
                sessionID,
                ...data,
              }) + EOL,
            )
            return true
          }
          return false
        }

        // Consume one subscribed event stream for the active session and mirror it
        // to stdout/UI. `client` is passed explicitly because attach mode may
        // rebind the SDK to the session's directory after the subscription is
        // created, and replies issued from inside the loop must use that client.
        //
        // F1e S7-prep: the loop consumes the NATIVE `session.next.*` / `permission.v2.*`
        // vocab (terminal events carry full values — text.ended/reasoning.ended/
        // tool.success — so no delta folding is needed). The V1 projections it used to
        // read (`message.part.updated`, `permission.asked`, `session.error`) are no
        // longer consumed, unblocking the S7 translator/projection delete. Tool
        // rendering still rides run/tool.ts, fed a minimal ToolPart-shaped adapter.
        /**
         * Did the turn actually END, or did we merely stop hearing about it?
         *
         * 🔴 `for await (… of events.stream)` exits NORMALLY when the SSE stream closes, so a dropped
         * subscription looked exactly like a completed turn: `loop()` returned, `completed` resolved
         * without error, and the CLI exited 0 having never waited for the model. Measured on the
         * `attach mode` flake — a failing run takes ~2.7 s against ~8.5 s for a passing one, sends
         * NOTHING to the provider (`llm.inputs` is `[]`), and writes not one byte to either stderr.
         * Nothing errored; the run simply stopped listening and called that success.
         *
         * ⚠️ `--attach` is where it bites because the stream crosses a socket to another process. An
         * in-process run's stream does not drop, which is why this looked like a test-fixture problem
         * for weeks.
         */
        let settled = false
        // Set when the SERVER says it is disposing this instance — see ./run/incomplete.
        let incomplete: IncompleteReason = "stream-ended"

        async function loop(
          client: NovaclawClient,
          events: Awaited<ReturnType<typeof sdk.v2.event.subscribe>>,
          directory: string,
        ) {
          const toggles = new Map<string, boolean>()
          // callID -> name+input captured at tool.called, joined with tool.success/failed.
          const calls = new Map<string, { tool: string; input: Record<string, unknown> }>()
          let error: string | undefined

          // Flatten native ToolContent[] into the flat output blob run/tool.ts renders
          // (text entries only — file entries carry no inline text).
          const flatten = (content: ReadonlyArray<{ type: string; text?: string }> | undefined) =>
            (content ?? [])
              .filter((item) => item.type === "text")
              .map((item) => item.text ?? "")
              .join("")

          const toolPart = (input: {
            callID: string
            state: Record<string, unknown> & { status: string }
          }): ToolPart => {
            const entry = calls.get(input.callID)
            const name = entry?.tool ?? "unknown"
            return {
              type: "tool",
              id: input.callID,
              callID: input.callID,
              sessionID,
              tool: name,
              state: {
                input: entry?.input ?? {},
                title: name,
                ...input.state,
              },
            } as unknown as ToolPart
          }

          const fail = (message: string, raw: unknown) => {
            error = error ? error + EOL + message : message
            if (emit("error", { error: raw })) return
            UI.error(message)
          }

          // ⚠️ **One formatter, shared with the transcript** (`@novaclaw/core/session/session-error`).
          // A local `errorMessage(err, fallback)` closure here would be a SECOND answer to one
          // question — a powered-off model server reading as raw wire text in the CLI and as a calm
          // sentence in the app. That divergence is what the shared taxonomy exists to end.
          //
          // **The CLI keeps the errno, deliberately, as an extra indented line.** The taxonomy's
          // headline is the truthful description (ruling 2 satisfied) and the raw message is
          // diagnostic detail ON TOP of it, never a contradiction of it. Four reasons this is the
          // right call for THIS surface and not for the chat: `novaclaw run` is documented in
          // AGENTS.md as the way to exercise a model through the real pipeline, i.e. its entire
          // audience is diagnosing something; nobody is reading their own conversation here, so
          // there is no lay user the suppression protects; the raw text is already on the wire and
          // in the session record, so printing it leaks nothing new; and `--format json` emits the
          // raw error object regardless, so hiding it from the human arm would just make the two
          // arms of one command disagree. There is no translator in the CLI, so the taxonomy's
          // English fallback is what renders — by design.
          //
          // The line policy itself lives in `sessionErrorLines` so it is unit-tested rather than
          // buried in this closure (ruling 1) — this call site owns only the indentation.
          const errorText = (err: unknown) => sessionErrorLines(sessionErrorLike(err)).join(EOL + "  ")

          for await (const event of events.stream) {
            if (process.env["NOVACLAW_RUN_DEBUG_EVENTS"]) console.error("EVT", event.type)
            // BEFORE the session filter, deliberately: the disposal carries only `{ directory }`,
            // so the filter below would skip it as "not mine" — and it is the one event that
            // explains why this stream is about to end.
            // The contract stream is instance-wide, so another directory's disposal is not ours.
            if (event.type === "server.instance.disposed") {
              if (event.data.directory === directory) incomplete = "disposed"
              continue
            }
            const scoped = (event as { data?: { sessionID?: string } }).data
            if (scoped?.sessionID !== sessionID) continue

            if (event.type === "session.next.step.started") {
              if (emit("step_start", { step: { agent: event.data.agent, model: event.data.model } })) {
                continue
              }
              if (args.format !== "json" && toggles.get("start") !== true) {
                UI.empty()
                UI.println(`> ${event.data.agent} · ${event.data.model.id}`)
                UI.empty()
                toggles.set("start", true)
              }
            }

            if (event.type === "session.next.step.ended") {
              const { timestamp: _t, sessionID: _s, assistantMessageID: _m, ...step } = event.data
              if (emit("step_finish", { step })) continue
            }

            if (event.type === "session.next.tool.called") {
              calls.set(event.data.callID, {
                tool: event.data.tool,
                input: event.data.input,
              })
              if (event.data.tool === "task" && args.format !== "json") {
                if (toggles.get(event.data.callID) === true) continue
                await tool(toolPart({ callID: event.data.callID, state: { status: "running" } }))
                toggles.set(event.data.callID, true)
              }
            }

            if (event.type === "session.next.tool.success") {
              const output = flatten(event.data.content)
              if (
                emit("tool_use", {
                  tool: calls.get(event.data.callID)?.tool ?? "unknown",
                  callID: event.data.callID,
                  input: calls.get(event.data.callID)?.input ?? {},
                  output,
                  structured: event.data.structured,
                })
              ) {
                continue
              }
              await tool(
                toolPart({
                  callID: event.data.callID,
                  state: { status: "completed", output, metadata: event.data.structured },
                }),
              )
            }

            if (event.type === "session.next.tool.failed") {
              const message = errorText(event.data.error)
              if (
                emit("tool_use", {
                  tool: calls.get(event.data.callID)?.tool ?? "unknown",
                  callID: event.data.callID,
                  input: calls.get(event.data.callID)?.input ?? {},
                  error: event.data.error,
                })
              ) {
                continue
              }
              await toolError(toolPart({ callID: event.data.callID, state: { status: "error", error: message } }))
              UI.error(message)
            }

            if (event.type === "session.next.text.ended") {
              if (emit("text", { text: event.data.text })) continue
              const text = event.data.text.trim()
              if (!text) continue
              if (!process.stdout.isTTY) {
                process.stdout.write(text + EOL)
                continue
              }
              UI.empty()
              UI.println(text)
              UI.empty()
            }

            if (event.type === "session.next.reasoning.ended" && thinking) {
              if (emit("reasoning", { text: event.data.text })) continue
              const text = event.data.text.trim()
              if (!text) continue
              const line = `Thinking: ${text}`
              if (process.stdout.isTTY) {
                UI.empty()
                UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                UI.empty()
                continue
              }
              process.stdout.write(line + EOL)
            }

            // Turn-level failures: step.failed carries the mid-turn error; a pre-turn
            // setup failure (model resolution &c.) surfaces as a synthetic notice.
            if (event.type === "session.next.step.failed") {
              fail(errorText(event.data.error), event.data.error)
            }

            if (event.type === "session.next.synthetic") {
              const text = event.data.text.trim()
              if (text) fail(text, { message: text })
            }

            if (event.type === "session.status" && event.data.status.type === "idle") {
              settled = true
              break
            }
          }
          return error
        }
        // ⚠️ `sess.directory` BEFORE the fallback in both modes. `directory` is set only when the
        // caller passed `--dir`; when they resumed by id instead, the session's own location is the
        // answer, and preferring the process's root is what put the subscription in the wrong scope.
        // ⚠️ `args.dir`, not `directory`. On the local path `directory` FALLS BACK to the run root
        // when no `--dir` was given, so a `directory ?? sess.directory` chain never reaches the
        // session — it is never undefined. The question is whether the caller NAMED a directory, and
        // only `args.dir` answers that. An explicit `--dir` still wins: the user said where.
        const cwd = args.dir
          ? (directory ?? root)
          : args.attach
            ? (sess.directory ?? (await current(sdk)))
            : (sess.directory ?? directory ?? root)
        const client = rebind(cwd)

        // Validate agent if specified
        const agent = await chosenAgent(client)

        // `/api/event` — the contract stream; the legacy `/event` this read until 2026-09-03 is gone.
        const events = await client.v2.event.subscribe()
        const completed = loop(client, events, cwd).catch((e) => {
          console.error(e)
          process.exitCode = 1
        })
        // Wait for the turn to finish: the async prompt/command endpoints return
        // before the turn runs, so completion is the `session.status idle` event
        // that `loop()` breaks on (`completed`). This holds for both local and
        // --attach runs — previously the blocking `prompt` call was itself the
        // wait, so attach could skip it; with `promptAsync` the idle event is the
        // only completion signal, so we must always await it or the process
        // exits before the (possibly remote) turn has run.
        async function finish() {
          const error = await completed
          if (error) process.exitCode = 1
          // 🔴 The stream ended without our turn settling — see `settled` above. Treating that as
          // success is how an attached run exited 0 in ~2.7 s having sent nothing to the model.
          // Say so and fail, rather than reporting a turn that never happened.
          else if (!settled) {
            UI.error(incompleteMessage(incomplete))
            process.exitCode = 1
          }
        }

        if (args.command) {
          const result = await client.v2.session.command({
            sessionID,
            agent,
            model: args.model,
            command: args.command,
            // The one consumer of the quoted form — a slash command re-splits this string.
            arguments: commandArguments,
            variant: args.variant,
          })
          if (result.error) {
            if (!emit("error", { error: result.error })) UI.error(formatRunError(result.error))
            // ⚠️ Same shape as the one fixed in `src/index.ts`: `formatRunError` reaches
            // `FormatError`, which reports a CliError's own exit code by ASSIGNING
            // `process.exitCode`. Overwriting it unconditionally here discards whatever it just
            // said. Default to 1 only when nothing has claimed a code.
            if (!process.exitCode) process.exitCode = 1
            return
          }
          await finish()
          return
        }

        const model = pick(args.model)
        // Deliver via the async endpoint (the V2/V1 router). It returns 204
        // immediately; the turn's completion is signalled by the `session.status
        // idle` event that `loop()` breaks on, and turn-level failures arrive as
        // `session.next.step.failed` / `session.next.synthetic` events.
        // `result.error` here carries only request-level (e.g. 400/404) failures.
        // The blocking `session.prompt` endpoint is legacy-only and 400s on native
        // V2 sessions, so the headless runner must use `promptAsync` to reach the
        // V2 engine.
        // V1-nuke slice D: the native prompt takes {text, files}; the per-turn agent/model persist
        // via the switch ops (the V2 semantics — the V1 promptAsync carried them inline).
        /**
         * 🔴 **A SILENT DEFAULT, TWICE — the same shape as the `--agent` refusal below it.**
         *
         * Both halves of this block used to swallow the caller's instruction and exit 0:
         *
         *   1. `if (providerID && modelID)` with no `else`. A `--model` ref without a `/` — a bare
         *      `opus`, a typo, a model id pasted without its provider — skipped `switchModel`
         *      ENTIRELY and the run proceeded on whatever model the session already had. So did
         *      `--variant`, which rides this call and was dropped with it.
         *   2. `.catch(() => undefined)`. A refused or failed switch was folded into the same value
         *      a successful one produces, and the turn ran on the old model.
         *
         * A run that did the work with the wrong model is worse than one that did not run: its
         * output looks authoritative. The existing "unknown model exits nonzero" test covers
         * neither — it passes a well-formed ref that stores fine and fails later at generation.
         */
        if (model) {
          const [providerID, ...restModel] = model.split("/")
          const modelID = restModel.join("/")
          if (!providerID || !modelID) {
            UI.error(`could not run with model "${model}": expected "providerID/modelID"`)
            process.exit(1)
          }
          const switched = await client.v2.session
            .switchModel({
              sessionID,
              model: { providerID, id: modelID, ...(args.variant ? { variant: args.variant } : {}) },
            })
            .catch((error: unknown) => ({ error }))
          if (switched && "error" in switched && switched.error) {
            UI.error(`could not run with model "${model}": ${String(switched.error)}`)
            process.exit(1)
          }
        }
        /**
         * 🔴 **A REFUSED SWITCH IS NOT A FALLBACK.** This was
         * `.catch(() => undefined)`: a run asked for `--agent codesleuth-auditor`, the switch was
         * refused, and it went on as whoever the session already belonged to — WITHOUT that
         * colleague's MCP grants — and exited zero. A run that silently did the work as the wrong
         * agent is worse than one that did not run: its output looks authoritative.
         *
         * ⚠️ Refusal is EXPECTED here and is not a malfunction: one chat per colleague means
         * switching an existing chat onto a colleague who already has one is denied by the kernel.
         * That is precisely the case worth reporting — the caller asked for a colleague this session
         * cannot become.
         */
        if (agent) {
          const switched = await client.v2.session.switchAgent({ sessionID, agent }).catch((error: unknown) => ({
            error,
          }))
          if (switched && "error" in switched && switched.error) {
            UI.println(
              UI.Style.TEXT_DANGER_BOLD + "✗",
              UI.Style.TEXT_NORMAL,
              `could not run as agent "${agent}": ${String(switched.error)}`,
            )
            process.exit(1)
          }
        }
        const result = await client.v2.session.prompt({
          sessionID,
          prompt: {
            text: message,
            ...(files.length > 0
              ? { files: files.map((file) => ({ uri: file.url, sourceUri: file.sourceUrl, name: file.filename })) }
              : {}),
          },
        })
        if (result.error) {
          if (!emit("error", { error: result.error })) UI.error(formatRunError(result.error))
          // ⚠️ Second instance of the `src/index.ts` clobber — see the note at the `--command` arm.
          if (!process.exitCode) process.exitCode = 1
          return
        }
        await finish()
        return
      }

      if (args.attach) {
        const sdk = attachSDK(directory)
        await execute(sdk, attachSDK)
      } else {
        if (!local) throw new Error("Local run started without its in-process HTTP handler")
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          const headers = new Headers(request.headers)
          const auth = ServerAuth.header()
          if (auth) headers.set("Authorization", auth)
          return local.handler(new Request(request, { headers }))
        }) as typeof globalThis.fetch
        // One builder, two uses: the client the run starts with, and the one it rebinds to once the
        // session's own directory is known. Sharing `fetchFn` keeps both on the SAME in-process
        // instance — the rebind changes which LOCATION the requests declare, not which server
        // answers them.
        const localClient = (dir?: string) =>
          createNovaclawClient({ baseUrl: "http://novaclaw.internal", fetch: fetchFn, directory: dir })
        await execute(localClient(directory), localClient)
      }

      // One-shot headless command (the header's contract: "…and exits"). The in-process
      // instance keeps LIVE handles (file watchers, the event bus, the memory engine) that
      // hold bun alive after the turn settles — every CLI/smoke run leaked a ~1.5 GB orphan
      // (issues.md P2; the accumulation behind the 2026-07-20 OOM crash). Flush stdout,
      // then exit explicitly — best-effort background housekeeping dies with the process,
      // which is exactly the deal a one-shot CLI offers.
      await new Promise<void>((resolve) => process.stdout.write("", () => resolve()))
    })
    if (local) yield* local.dispose
    process.exit(process.exitCode ?? 0)
  }),
})
