import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { Icon } from "@novaclaw/ui/v2/icon"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { type Component, For, Show, createMemo, createSignal } from "solid-js"
import { RequiresLevel } from "@/context/expertise"
import { useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { discoverInstances, type DiscoveredInstance } from "@/utils/instance-discovery"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { reportedWrite } from "@/utils/config-write"
import { showToast } from "@/utils/toast"
import { mergePeer, type Peer } from "./peer-token"

// P2P inter-instance access (Settings → Instances):
//   1. "This instance" — the INCOMING API token (config server.password; HTTP Basic, username
//      "novaclaw"). Gating applies live (the auth middlewares re-read the store per request);
//      clearing writes "" = open server.
//      ⚠️ That empty string is the ENCODING, not a workaround for a missing delete — the comment
//      here used to say "(patch-merge cannot delete keys)", which framed a correct design as a
//      limitation and sent a later reader looking for `POST /api/config/remove`. The single
//      consumer, `ServerToken.storedPassword`, reads `password.length > 0 ? password : undefined`,
//      so `""` and absent are the same state by definition. Removing the key instead would add a
//      second code path to reach a state this one already reaches.
//   2. "Agent peers" — the `instances` config array: peer NovaClaw instances THIS instance's
//      agents may drive free-form over HTTP. Each peer surfaces to models as
//      NOVACLAW_INSTANCE_<NAME>_URL/_TOKEN env in bash plus a system-prompt line.
export const InstancesAccess: Component = () => {
  const language = useLanguage()
  const serverSync = useServerSync()
  const server = useServer()
  const global = useGlobal()

  const config = createMemo(() => serverSync().data.config as { server?: { password?: string }; instances?: Peer[] })
  const [tokenDraft, setTokenDraft] = createSignal<string | undefined>(undefined)
  const tokenSaved = createMemo(() => config().server?.password ?? "")
  const tokenValue = () => tokenDraft() ?? tokenSaved()
  const tokenDirty = () => tokenDraft() !== undefined && tokenDraft() !== tokenSaved()
  /**
   * ⚠️ Both writers below report, and both report BESIDE the field rather than only in a toast.
   * They used to end `.catch(() => undefined)` — a rejected credential write said nothing anywhere,
   * and the peer writer went on to clear the pasted token on the next line. A secret a person can
   * no longer see, was never told was dropped, and must go back to its source to recover is the
   * sharpest form of ruling 2's *a failed mutation never reports success*.
   */
  const [tokenError, setTokenError] = createSignal<string | undefined>(undefined)
  const [peerError, setPeerError] = createSignal<string | undefined>(undefined)
  const saveToken = async (next: string) => {
    const saved = await reportedWrite(
      () =>
        serverSync().updateConfig({ server: { ...(config().server ?? {}), password: next } } as never, {
          // The server applies the new credential before this response returns. Change the saved
          // connection in the same success turn, before any follow-up read can use the old header.
          onAccepted: () => {
            server.setIncomingToken(server.key, next)
            setTokenDraft(undefined)
          },
          // Updating the connection rebuilds its SDK context; that new context owns the bootstrap.
          refetch: false,
        }),
      (error) => {
        setTokenError(`${language.t("settings.instances.access.saveFailed")} ${error}`)
        showToast({
          variant: "error",
          title: language.t("settings.instances.access.saveFailed"),
          description: error,
        })
      },
    )
    if (saved.ok) setTokenError(undefined)
    return saved
  }
  const tokenSource = createMemo(() => global.servers.health[server.key]?.auth?.source)
  const tokenSourceCopy = createMemo(() => {
    if (tokenSource() === "stored") return language.t("settings.instances.access.source.stored")
    if (tokenSource() === "launcher") return language.t("settings.instances.access.source.launcher")
    if (tokenSource() === "open") return language.t("settings.instances.access.source.open")
    return language.t("settings.instances.access.source.checking")
  })

  const peers = createMemo(() => config().instances ?? [])
  const [draft, setDraft] = createSignal<Peer>({ name: "", url: "", token: "" })
  // Masked by default, revealable on request — the same stance as the model API key: the ask is to
  // SEE it, and a secret legible to anyone glancing at a shared screen is a different promise.
  const [revealPeerToken, setRevealPeerToken] = createSignal(false)

  // Rule 2, offer what exists: the LAN already knows which instances are reachable, so asking a
  // person to type `http://host:port` asks them to look up something the product can see.
  //
  // ⚠️ Scanning is a deliberate ACTION, never an on-open effect. It is real network work on the
  // instance, and Settings → Instances is opened for other reasons far more often than for adding a
  // peer. ⚠️ `self` is filtered out — the scanning instance always finds itself, and offering it
  // would invite a peer pointing at the machine you are already using.
  const [scanning, setScanning] = createSignal(false)
  const [found, setFound] = createSignal<DiscoveredInstance[] | undefined>(undefined)
  const scan = async () => {
    const connection = server.current ?? global.servers.list()[0]
    if (!connection) return
    setScanning(true)
    try {
      setFound((await discoverInstances(connection.http)).filter((instance) => !instance.self))
    } catch {
      // A failed scan must leave the manual fields usable rather than blocking the row: an empty
      // result and an unreachable network look the same to a user, and both mean "type it".
      setFound([])
    } finally {
      setScanning(false)
    }
  }
  const savePeers = async (next: Peer[]) => {
    const saved = await reportedWrite(
      () =>
        serverSync().updateConfig({
          instances: next.map((peer) => ({
            name: peer.name,
            url: peer.url,
            ...(peer.token ? { token: peer.token } : {}),
          })),
        } as never),
      (error) => {
        setPeerError(`${language.t("settings.instances.peers.saveFailed")} ${error}`)
        showToast({ variant: "error", title: language.t("settings.instances.peers.saveFailed"), description: error })
      },
    )
    if (saved.ok) setPeerError(undefined)
    return saved
  }
  const addPeer = async () => {
    const value = draft()
    const merged = mergePeer({ draft: value, existing: peers().find((peer) => peer.name === value.name.trim()) })
    if (merged === undefined) return
    const saved = await savePeers([...peers().filter((peer) => peer.name !== merged.name), merged])
    // 🔴 The draft is cleared ONLY once the write landed. Clearing it beside the call — before the
    // write could even settle — is what discarded a pasted bearer token on every rejection.
    if (!saved.ok) return
    setDraft({ name: "", url: "", token: "" })
  }

  /** Load a saved peer into the draft so it can be SEEN and changed rather than only deleted. */
  const editPeer = (peer: Peer) => {
    setRevealPeerToken(false)
    setDraft({ name: peer.name, url: peer.url, token: peer.token ?? "" })
  }

  return (
    <RequiresLevel min="advanced">
      <div class="flex flex-col gap-2 pb-3" data-slot="instances-access">
        <div class="flex flex-col gap-1">
          <span class="text-[13px] font-semibold text-v2-text-text-base">
            {language.t("settings.instances.access.title")}
          </span>
          <span class="text-[12px] leading-snug text-v2-text-text-faint">
            {language.t("settings.instances.access.hint")}
          </span>
          <span class="text-[12px] leading-snug text-v2-text-text-faint" data-slot="instances-access-source">
            {tokenSourceCopy()}
          </span>
          <div class="flex items-center gap-2 pt-1">
            <TextInputV2
              type="password"
              appearance="base"
              value={tokenValue()}
              onInput={(event) => {
                setTokenError(undefined)
                setTokenDraft(event.currentTarget.value)
              }}
              placeholder={language.t("settings.instances.access.placeholder")}
              aria-label={language.t("settings.instances.access.placeholder")}
              autocomplete="off"
              data-slot="instances-access-token"
            />
            <Show when={tokenDirty()}>
              <ButtonV2
                size="small"
                variant="contrast"
                data-action="instances-access-save"
                onClick={() => void saveToken(tokenValue())}
              >
                {language.t("common.save")}
              </ButtonV2>
            </Show>
            <Show when={!tokenDirty() && tokenSaved().length > 0}>
              <ButtonV2
                size="small"
                variant="neutral"
                data-action="instances-access-clear"
                onClick={() => void saveToken("")}
              >
                {language.t("common.clear")}
              </ButtonV2>
            </Show>
          </div>
          <Show when={tokenError()}>
            <span
              class="text-[12px] leading-snug break-all"
              style={{ color: "var(--v2-state-danger-text, #ef4444)" }}
              data-slot="instances-access-error"
            >
              {tokenError()}
            </span>
          </Show>
        </div>

        <div class="flex flex-col gap-1 pt-2">
          <span class="text-[13px] font-semibold text-v2-text-text-base">
            {language.t("settings.instances.peers.title")}
          </span>
          <span class="text-[12px] leading-snug text-v2-text-text-faint">
            {language.t("settings.instances.peers.hint")}
          </span>
          <For each={peers()}>
            {(peer) => (
              <div class="flex items-center gap-2 pt-1" data-slot="instances-peer-row">
                <span class="font-mono text-[12px] text-v2-text-text-base">{peer.name}</span>
                <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-v2-text-text-faint">{peer.url}</span>
                <ButtonV2
                  size="small"
                  variant="neutral"
                  data-action="instances-peer-edit"
                  onClick={() => editPeer(peer)}
                >
                  {language.t("common.edit")}
                </ButtonV2>
                <ButtonV2
                  size="small"
                  variant="neutral"
                  data-action="instances-peer-remove"
                  onClick={() => void savePeers(peers().filter((item) => item.name !== peer.name))}
                >
                  {language.t("common.remove")}
                </ButtonV2>
              </div>
            )}
          </For>
          <div class="flex flex-wrap items-center gap-2 pt-1" data-slot="instances-peer-discover">
            <ButtonV2 size="small" variant="neutral" data-action="instances-peer-scan" onClick={() => void scan()}>
              {scanning()
                ? language.t("settings.instances.peers.scanning")
                : language.t("settings.instances.peers.scan")}
            </ButtonV2>
            <Show when={found()?.length}>
              <For each={found()}>
                {(instance) => (
                  <ButtonV2
                    size="small"
                    variant="neutral"
                    data-action="instances-peer-pick"
                    onClick={() => setDraft({ ...draft(), name: instance.name, url: instance.url })}
                  >
                    {instance.name} — {instance.url}
                  </ButtonV2>
                )}
              </For>
            </Show>
            {/* An empty scan says so. Silence would read as "still scanning" or as a broken button,
                and the honest next step is the manual fields immediately below. */}
            <Show when={found() !== undefined && found()!.length === 0 && !scanning()}>
              <span class="settings-v2-field-description">{language.t("settings.instances.peers.none")}</span>
            </Show>
          </div>
          <div class="flex flex-wrap items-center gap-2 pt-1" data-slot="instances-peer-add">
            <TextInputV2
              appearance="base"
              value={draft().name}
              onInput={(event) => setDraft({ ...draft(), name: event.currentTarget.value })}
              placeholder={language.t("settings.instances.peers.name")}
              aria-label={language.t("settings.instances.peers.name")}
              autocomplete="off"
            />
            <TextInputV2
              appearance="base"
              value={draft().url}
              onInput={(event) => setDraft({ ...draft(), url: event.currentTarget.value })}
              placeholder={language.t("settings.instances.peers.url")}
              aria-label={language.t("settings.instances.peers.url")}
              autocomplete="off"
            />
            <TextInputV2
              type={revealPeerToken() ? "text" : "password"}
              appearance="base"
              value={draft().token ?? ""}
              onInput={(event) => setDraft({ ...draft(), token: event.currentTarget.value })}
              placeholder={language.t("settings.instances.peers.token")}
              aria-label={language.t("settings.instances.peers.token")}
              autocomplete="off"
            />
            <IconButtonV2
              size="small"
              variant="ghost-muted"
              data-action="instances-peer-token-reveal"
              onClick={() => setRevealPeerToken(!revealPeerToken())}
              icon={<Icon name={revealPeerToken() ? "eye-off" : "eye"} size="normal" />}
              aria-label={language.t(
                revealPeerToken() ? "settings.instances.peers.token.hide" : "settings.instances.peers.token.reveal",
              )}
            />
            <ButtonV2 size="small" variant="neutral" data-action="instances-peer-addbtn" onClick={() => void addPeer()}>
              {language.t("settings.instances.peers.add")}
            </ButtonV2>
          </div>
          <Show when={peerError()}>
            <span
              class="text-[12px] leading-snug break-all"
              style={{ color: "var(--v2-state-danger-text, #ef4444)" }}
              data-slot="instances-peer-error"
            >
              {peerError()}
            </span>
          </Show>
        </div>
      </div>
    </RequiresLevel>
  )
}
