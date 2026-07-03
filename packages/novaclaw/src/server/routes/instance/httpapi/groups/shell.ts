import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

// B11 — the bundled-shell surface: what shell/git the agents actually get on this
// machine, and the provisioner that installs the PortableGit substrate (Windows).
// Provisioning is a provision-BEFORE-airgap operation: it fails closed in offline mode.

const root = "/shell"

export const BundleInfo = Schema.Struct({
  root: Schema.String,
  bash: Schema.String,
  git: Schema.String,
  version: Schema.optional(Schema.String),
  provisionedAt: Schema.optional(Schema.Finite),
})

export const ShellStatus = Schema.Struct({
  platform: Schema.String,
  /** What the bash tool runs when no shell is configured (Shell.agentDefault). */
  agentShell: Schema.String,
  /** The effective bash for agents, when one exists at all. */
  bash: Schema.NullOr(Schema.String),
  /** The effective git binary (system PATH first, bundled fallback). */
  git: Schema.NullOr(Schema.String),
  bundle: Schema.NullOr(BundleInfo),
  /** True on Windows — the only platform the provisioner targets. */
  provisionSupported: Schema.Boolean,
})

export const OfflineLayer = Schema.Struct({
  layer: Schema.Finite,
  name: Schema.String,
  active: Schema.Boolean,
  detail: Schema.optional(Schema.String),
})

export const OfflineStatus = Schema.Struct({
  enabled: Schema.Boolean,
  active: Schema.Finite,
  total: Schema.Finite,
  layers: Schema.Array(OfflineLayer),
})

export const ShellApi = HttpApi.make("shell")
  .add(
    HttpApiGroup.make("shell")
      .add(
        HttpApiEndpoint.get("status", `${root}/status`, {
          query: WorkspaceRoutingQuery,
          success: described(ShellStatus, "The agent shell substrate on this machine"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "shell.status",
            summary: "Shell substrate status",
            description:
              "Which bash/git the agents get (bundled PortableGit, system, or platform fallback) and whether the bundle is provisioned.",
          }),
        ),
        HttpApiEndpoint.get("offline", `${root}/offline`, {
          query: WorkspaceRoutingQuery,
          success: described(OfflineStatus, "The N/9 offline-layer posture"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "shell.offline",
            summary: "Offline layer status",
            description: "The airgap posture: how many of the 9 offline layers are active, with per-layer detail (OFF-C).",
          }),
        ),
        HttpApiEndpoint.post("provision", `${root}/provision`, {
          query: WorkspaceRoutingQuery,
          success: described(ShellStatus, "Status after provisioning"),
          error: InvalidRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "shell.provision",
            summary: "Provision the bundled shell",
            description:
              "Download + verify + extract the pinned PortableGit bundle (bash + git) into the data dir. Windows-only; fails closed in offline mode (provision before going airgapped).",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "shell",
          description: "B11 bundled-shell substrate: status + provisioner.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "novaclaw experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
