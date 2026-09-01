export * as ConfigComputer from "./computer"

import { Schema } from "effect"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConfigAnnotation } from "@novaclaw/schema/config-annotation"
import { optional } from "@novaclaw/schema/schema"

/** The default capture path when none is configured. Declared above `Info` because the schema's own
 *  `default` annotation names this binding rather than repeating its value. */
// JPEG keeps full-window browser observations small enough for a long native Computer Use loop.
// A measured 1435x1000 Chrome PNG was 1.05 MiB and its base64 projection alone was estimated at
// 148k context tokens; the worker then crossed its containment boundary during the next capture.
// Screens are observations, not archival assets, so bounded lossy encoding is the correct default.
export const DEFAULT_SCREENSHOT_PATH = path.join(tmpdir(), "novaclaw-computer.jpg")

/**
 * Where the `computer` tool sends its input, and where it captures from.
 *
 * ⚠️ **A display is CONFIGURED here or the tool declines — it is never inherited from the process
 * environment.** On a headless server an inherited `DISPLAY` fails; on a Linux desktop it succeeds and
 * silently drives the operator's REAL X11 screen, which is human-gated by
 * design. The second failure is much worse than the first, and only an explicit setting
 * distinguishes "I have an X11 sandbox" from "I happen to be sitting at a monitor". Windows real
 * desktop control never reads this field; it uses a session's approved HWND/PID/executable binding.
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
  screenshotPath: ConfigAnnotation.depends(
    ConfigAnnotation.withDefault(
      Schema.String.pipe(optional).annotate({
        description: "Path inside the substrate where screenshots are written. Defaults to a temp file.",
      }),
      // Declared as the constant, not as a copy of it — `config-projection.test.ts` pins the two together.
      { value: DEFAULT_SCREENSHOT_PATH, source: "config/computer.ts DEFAULT_SCREENSHOT_PATH" },
    ),
    [
      {
        path: ["computer", "display"],
        when: "set",
        effect: "the computer tool is unavailable and captures nothing, so the path is never written",
        source: "packages/core/src/config/computer.ts (display: 'Absent = the tool is unavailable')",
      },
    ],
  ),
}).annotate({ identifier: "ConfigComputer.Info" })
