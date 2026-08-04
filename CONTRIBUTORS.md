# Contributors

NovaClaw is written by Nancy Sadkov. This file credits everyone else whose work is in the tree.

**Why a file and not `git log`.** The public repository is a *snapshot*: each release replaces it with
a single fresh commit built from the canonical tree, so no authorship survives in its history —
not mine either. A patch that arrives as a pull request is **ported**, not merged (the canonical tree
has usually moved well past the snapshot the patch was written against, and the two share no common
ancestor, so the diff does not apply). The port lands under my name with the original author cited in
its commit message, and that citation is invisible to anyone reading the published repository. So the
credit lives here, where a snapshot carries it forward.

If your work is in NovaClaw and your name is not below, that is a bug — please say so.

## Contributors

### [@DassaultFalconKing](https://github.com/DassaultFalconKing)

Linux packaging, and a run of defect reports and fixes across the kernel and the UI. Ported from
pull requests on the published snapshot:

| PR | What it fixed |
|----|---------------|
| [#1](https://github.com/NancySadkov/novaclaw/pull/1) | Linux standalone launch and distribution packages. Reconstructing the Electron sidecar build script to build at all is what exposed that the v0.1.0 publish had silently dropped `packages/novaclaw/script/build-node.ts` — the published source could not build the sidecar. That find is the most valuable single thing anyone outside has contributed. |
| [#3](https://github.com/NancySadkov/novaclaw/pull/3) | Public assets resolved against the runtime base rather than the origin root, so the UI works when served from a sub-path. |
| [#4](https://github.com/NancySadkov/novaclaw/pull/4) | Three separate defects found while validating Linux distribution builds: a truncated turn now recovers once and then stops honestly; a model that calls a tool which does not exist is told which ones do; the desktop app ships its window icons and never loads an inherited dev server when packaged. |
| [#6](https://github.com/NancySadkov/novaclaw/pull/6) | The `apply_patch` doom-loop is keyed on the file, not on how the patch happens to be spelled. |
| [#7](https://github.com/NancySadkov/novaclaw/pull/7) | A tool call the model promised but never made no longer leaves the turn waiting on a result that cannot arrive. |
| [#9](https://github.com/NancySadkov/novaclaw/pull/9) | A file the user attached to the conversation is not the agent's to overwrite — attachments are now identified by realpath and carried to every mutation tool's permission check. (Supersedes [#8](https://github.com/NancySadkov/novaclaw/pull/8), an earlier form of the same fix.) |
| [#10](https://github.com/NancySadkov/novaclaw/pull/10) | An exited session's controls settle, and a failed stop says so. |
| [#11](https://github.com/NancySadkov/novaclaw/pull/11) | A lost pointer gesture no longer leaves the home launcher inert. |
| [#12](https://github.com/NancySadkov/novaclaw/pull/12) | An ungrouped `Select` rendered empty — silently breaking the Settings, model and thinking-level selectors. |
| [#14](https://github.com/NancySadkov/novaclaw/pull/14) | Provider turns recover instead of failing the session; MCP connection outcomes are reported truthfully; child joins are event-driven; model setup stays responsive. |
| [#15](https://github.com/NancySadkov/novaclaw/pull/15) | `novaclaw run` keeps its stdout protocol-clean. |

## Upstream

NovaClaw inherited part of its codebase from [opencode](https://github.com/anomalyco/opencode) (MIT).
That attribution lives in [`NOTICE`](NOTICE), [`licenses/`](licenses), and Settings → About.

## Sending a patch

See [CONTRIBUTING.md](CONTRIBUTING.md). Patches arrive by email; a pull request on the snapshot works
too, and is how everything above arrived — just expect it to be ported rather than merged.
