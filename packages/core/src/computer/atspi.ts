export * as ComputerAtSpi from "./atspi"

import { ComputerAccessibility } from "./accessibility"
import type { ComputerCoordinates } from "./coordinates"
import type { ComputerDriver } from "./driver"

export interface Plan {
  readonly argv: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}

const env = (display: string): Readonly<Record<string, string>> => ({
  DISPLAY: display,
  NO_AT_BRIDGE: "0",
  GTK_A11Y: "always",
})

/**
 * Linux AT-SPI enumeration through Ubuntu's apt-packaged `python3-pyatspi`.
 *
 * The id is a traversal index (`root/0/0/0`), not a process-local object address. Invocation walks
 * the tree again and revalidates the node's own name before acting, so a changed tree is a refusal.
 * Each property/interface read is isolated: an application node that lacks Component must not hide
 * all of its actionable descendants, which is exactly what the first live probe exposed.
 */
export const SCAN_SOURCE = String.raw`
import json
import pyatspi

desktop = pyatspi.Registry.getDesktop(0)
out = []
todo = [(desktop, "root")]
while todo:
    node, path = todo.pop()
    children = []
    try:
        children = [node.getChildAtIndex(i) for i in range(node.childCount)]
    except Exception:
        pass
    todo.extend((child, path + "/" + str(i)) for i, child in enumerate(children))
    try:
        name = node.name
        role = node.getRoleName()
    except Exception:
        continue
    try:
        ext = node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
    except Exception:
        continue
    actions = []
    try:
        action = node.queryAction()
        actions = [action.getName(i) for i in range(action.nActions)]
    except Exception:
        pass
    out.append({
        "id": path,
        "role": role,
        "name": name,
        "bounds": {"x": ext.x, "y": ext.y, "width": ext.width, "height": ext.height},
        "actions": actions,
    })
print(json.dumps(out, separators=(",", ":")))
`.trim()

/** Exact id/name/action verification followed by one semantic action. Arguments are argv, never code. */
export const INVOKE_SOURCE = String.raw`
import json
import sys
import pyatspi

element_id, own_name, action_name = sys.argv[1:4]
parts = element_id.split("/")
if not parts or parts[0] != "root" or any(not part.isdigit() for part in parts[1:]):
    print(json.dumps({"ok": False, "reason": "invalid traversal id"}))
    raise SystemExit(2)
node = pyatspi.Registry.getDesktop(0)
for part in parts[1:]:
    index = int(part)
    if index < 0 or index >= node.childCount:
        print(json.dumps({"ok": False, "reason": "tree changed before invocation"}))
        raise SystemExit(3)
    node = node.getChildAtIndex(index)
actual_name = " ".join(node.name.split())
expected_name = " ".join(own_name.split())
if actual_name != expected_name:
    print(json.dumps({"ok": False, "reason": "tree changed before invocation: own name differs"}))
    raise SystemExit(4)
action = node.queryAction()
for index in range(action.nActions):
    if action.getName(index) == action_name:
        if action.doAction(index) is False:
            print(json.dumps({"ok": False, "reason": "application refused the advertised action"}))
            raise SystemExit(5)
        print(json.dumps({"ok": True}))
        raise SystemExit(0)
print(json.dumps({"ok": False, "reason": "action is no longer advertised"}))
raise SystemExit(6)
`.trim()

export const scanPlan = (display: string): Plan => ({ argv: ["python3", "-c", SCAN_SOURCE], env: env(display) })

export const invokePlan = (display: string, request: ComputerDriver.AccessibilityInvokeRequest): Plan => ({
  argv: ["python3", "-c", INVOKE_SOURCE, request.elementID, request.ownName, request.actionName],
  env: env(display),
})

export type ScanDecoded =
  | { readonly ok: true; readonly candidates: ReadonlyArray<ComputerAccessibility.Candidate>; readonly rejected: number }
  | { readonly ok: false; readonly reason: string }

export function decodeScan(stdout: string, viewport: ComputerCoordinates.Viewport): ScanDecoded {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch (error) {
    return { ok: false, reason: `AT-SPI scan did not return JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!Array.isArray(raw)) return { ok: false, reason: "AT-SPI scan did not return an array" }
  const normalized = ComputerAccessibility.normalize(raw, viewport)
  return { ok: true, candidates: normalized.candidates, rejected: normalized.rejected.length }
}

export function decodeInvoke(exitCode: number, stdout: string, stderr = ""): ComputerDriver.ActOutcome {
  try {
    const value = JSON.parse(stdout) as unknown
    if (typeof value === "object" && value !== null && "ok" in value && value.ok === true && exitCode === 0)
      return { ok: true }
    if (typeof value === "object" && value !== null && "reason" in value && typeof value.reason === "string")
      return { ok: false, reason: value.reason }
  } catch {
    // The exit/stderr fallback below is more actionable than JSON.parse's syntax text here.
  }
  const detail = stderr.trim() || stdout.trim() || "no output"
  return { ok: false, reason: `AT-SPI invocation exited ${exitCode}: ${detail}` }
}
