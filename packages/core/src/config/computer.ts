export * as ConfigComputer from "./computer"

import { Schema } from "effect"
import { optional } from "@novaclaw/schema/schema"

/**
 * Where the `computer` tool sends its input, and where it captures from.
 *
 * ⚠️ **A display is CONFIGURED here or the tool declines — it is never inherited from the process
 * environment.** On a headless server an inherited `DISPLAY` fails; on a Linux desktop it succeeds and
 * silently drives the operator's REAL screen, which is P6 and human-gated (`todo/computer-use.md`,
 * build order). The second failure is much worse than the first, and only an explicit setting
 * distinguishes "I have a sandbox" from "I happen to be sitting at a monitor".
 *
 * **This is the whole substrate binding.** Ruled 2026-08-06: the tool drives a display THIS instance
 * can reach, never a remote one — a transport to a box that runs commands for us is the client/server
 * split *an instance is ATOMIC* forbids. To drive a sandboxed desktop you run an instance inside the
 * sandbox and reach it as a peer, which is what *hard isolation is the OPERATOR's boundary* already
 * prescribes. So there is no host, port or container id here: just a display.
 *
 * It is a runtime-editable operational fact, per the self-healing law — an agent whose display moved
 * repairs it with one `PATCH /config`, no restart.
 */
export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  /**
   * X display the substrate serves, e.g. `":99"`. Absent = the tool is unavailable and says so.
   */
  display: Schema.String.pipe(optional).annotate({
    description: 'X display the computer tool drives, e.g. ":99". Unset means the tool is unavailable.',
  }),
  /**
   * Where screenshots are written inside the substrate. One reused path: the capture is read back
   * immediately, and a per-call filename would litter the sandbox for no benefit.
   */
  screenshotPath: Schema.String.pipe(optional).annotate({
    description: "Path inside the substrate where screenshots are written. Defaults to a temp file.",
  }),
}).annotate({ identifier: "ConfigComputer.Info" })

/** The default capture path when none is configured. */
export const DEFAULT_SCREENSHOT_PATH = "/tmp/novaclaw-computer.png"
