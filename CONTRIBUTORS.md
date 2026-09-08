# Contributors

NovaClaw is written by Nancy Sadkov. This file credits everyone else whose work is in the tree.

**Why a file and not `git log`.** Outside patches are **ported**, not merged: each is read for intent,
re-verified against the current tree, and applied under the maintainer's name with the original author
cited. This durable file keeps that credit visible.

If your work is in NovaClaw and your name is not below, that is a bug — please say so.

## Contributors

### @DassaultFalconKing

Linux packaging, and a run of defect reports and fixes across the kernel and the UI:

| Contribution | What it fixed |
|--------------|---------------|
| #1 | Linux standalone launch and distribution packages. Reconstructing the Electron sidecar build script to build at all is what exposed that the v0.1.0 publish had silently dropped `packages/novaclaw/script/build-node.ts` — the published source could not build the sidecar. That find is the most valuable single thing anyone outside has contributed. |
| #3 | Public assets resolved against the runtime base rather than the origin root, so the UI works when served from a sub-path. |
| #4 | Three separate defects found while validating Linux distribution builds: a truncated turn now recovers once and then stops honestly; a model that calls a tool which does not exist is told which ones do; the desktop app ships its window icons and never loads an inherited dev server when packaged. |
| #6 | The `apply_patch` doom-loop is keyed on the file, not on how the patch happens to be spelled. |
| #7 | A tool call the model promised but never made no longer leaves the turn waiting on a result that cannot arrive. |
| #9 | A file the user attached to the conversation is not the agent's to overwrite — attachments are now identified by realpath and carried to every mutation tool's permission check. (Supersedes contribution #8, an earlier form of the same fix.) |
| #10 | An exited session's controls settle, and a failed stop says so. |
| #11 | A lost pointer gesture no longer leaves the home launcher inert. |
| #12 | An ungrouped `Select` rendered empty — silently breaking the Settings, model and thinking-level selectors. |
| #14 | Provider turns recover instead of failing the session; MCP connection outcomes are reported truthfully; child joins are event-driven; model setup stays responsive. |
| #15 | `novaclaw run` keeps its stdout protocol-clean. |

## Sending a patch

See [CONTRIBUTING.md](CONTRIBUTING.md). Patches arrive by email and are ported rather than merged.
