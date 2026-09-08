import path from "path"
import { Global } from "../global"

// The managed tool-output store: where a tool's oversized output is spilled so the model can inspect it
// by path instead of blowing the context window.
//
// This lives in core (not `packages/novaclaw`, which re-exports it) because the PERMISSION layer needs the
// same value: the store sits outside every Location, so reading from it classifies as an external-directory
// read, and the unattended confinement stance would otherwise hard-deny an agent access to its OWN spilled
// output. Two copies of this path would let that exemption drift silently out of alignment — which is the
// sort of thing that fails closed in a way nobody notices until an unattended run mysteriously stalls.
export const TRUNCATION_DIR = path.join(Global.Path.data, "tool-output")

/**
 * The store as a permission RESOURCE. `LocationMutation.resolve` builds external-directory resources as
 * `slash(path.join(dir, "*"))`, so this must be slashed the same way to match — a `path.join` form with
 * Windows backslashes would silently never match.
 */
export const TRUNCATION_RESOURCE = path.join(TRUNCATION_DIR, "*").replaceAll("\\", "/")
