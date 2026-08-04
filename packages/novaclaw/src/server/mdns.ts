import { Bonjour } from "bonjour-service"

let bonjour: Bonjour | undefined
let currentPort: number | undefined

// Remote-access R7: advertise a NovaClaw-SPECIFIC service type (`_novaclaw._tcp`) instead of the
// generic `http` — browsing `http` would surface every printer/NAS on the LAN and give no way to
// recognize ours. The TXT record carries the instance's stable identity (`id`) so a discovering
// client can dedup the SAME instance seen behind different addresses (mDNS name vs IP).
export const SERVICE_TYPE = "novaclaw"

export function publish(port: number, domain?: string, txt?: Record<string, string>) {
  if (currentPort === port) return
  if (bonjour) unpublish()

  try {
    const host = domain ?? "novaclaw.local"
    const name = `novaclaw-${port}`
    bonjour = new Bonjour()
    const service = bonjour.publish({
      name,
      type: SERVICE_TYPE,
      host,
      port,
      txt: { path: "/", ...txt },
    })

    service.on("error", () => {})

    currentPort = port
  } catch {
    if (bonjour) {
      try {
        bonjour.destroy()
      } catch {}
    }
    bonjour = undefined
    currentPort = undefined
  }
}

export function unpublish() {
  if (bonjour) {
    try {
      bonjour.unpublishAll()
      bonjour.destroy()
    } catch {}
    bonjour = undefined
    currentPort = undefined
  }
}

export interface DiscoveredInstance {
  /** Advertised service name (`novaclaw-<port>`). */
  name: string
  /** Best reachable URL — IPv4 address preferred over the mDNS hostname (a `.local` name often
   *  fails to resolve for browsers/OS resolvers that lack an mDNS responder). */
  url: string
  /** The instance's stable identity from the TXT record, when the advertiser supplies one. */
  instanceID?: string
  /** Advertised NovaClaw version from the TXT record, when supplied. */
  version?: string
}

function pickAddress(addresses: string[] | undefined, host: string | undefined) {
  const ipv4 = (addresses ?? []).filter((a) => a.includes(".") && !a.startsWith("169.254.") && !a.startsWith("127."))
  return ipv4[0] ?? host
}

/** One bounded scan of the LAN for advertised NovaClaw instances. Opens a fresh mDNS browser,
 *  collects responses for `timeoutMs`, and tears the socket down — discovery is a point-in-time
 *  question, not a standing subscription. Never rejects: a socket error reports an empty LAN. */
export function browse(timeoutMs = 2500): Promise<DiscoveredInstance[]> {
  return new Promise((resolve) => {
    let scanner: Bonjour
    try {
      scanner = new Bonjour()
    } catch {
      resolve([])
      return
    }
    const found = new Map<string, DiscoveredInstance>()
    const finish = () => {
      try {
        browser.stop()
        scanner.destroy()
      } catch {}
      resolve([...found.values()])
    }
    const timer = setTimeout(finish, timeoutMs)
    const browser = scanner.find({ type: SERVICE_TYPE }, (service) => {
      const address = pickAddress(service.addresses, service.host)
      if (!address || !service.port) return
      const txt = (service.txt ?? {}) as Record<string, string>
      const entry: DiscoveredInstance = {
        name: service.name ?? `novaclaw-${service.port}`,
        url: `http://${address}:${service.port}`,
        instanceID: typeof txt.id === "string" && txt.id ? txt.id : undefined,
        version: typeof txt.v === "string" && txt.v ? txt.v : undefined,
      }
      // Dedup: the same instance may answer on several interfaces/addresses — its identity (or
      // failing that, its advertised name) collapses the duplicates to one row.
      found.set(entry.instanceID ?? entry.name, entry)
    })
    browser.on("error", () => {
      clearTimeout(timer)
      finish()
    })
  })
}

export * as MDNS from "./mdns"
