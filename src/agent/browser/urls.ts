export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string }

const PRIVATE_V4: [number, number][] = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10 (carrier-grade NAT)
  [0x7f000000, 8], // 127/8
  [0xa9fe0000, 16], // 169.254/16 (link-local, cloud metadata)
  [0xac100000, 12], // 172.16/12
  [0xc0a80000, 16], // 192.168/16
]

function privateV4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false
  const ip = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
  return PRIVATE_V4.some(([base, bits]) => ip >>> (32 - bits) === base >>> (32 - bits))
}

function privateV6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (!h.includes(':')) return false
  if (h === '::1' || h === '::') return true
  if (/^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h)) return true // unique-local, link-local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h)
  if (mapped) return privateV4(mapped[1])
  // The URL parser writes ::ffff:127.0.0.1 as ::ffff:7f00:1, so the mapped address arrives in hex.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
  if (!hex) return false
  const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)]
  return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
}

/** A host on your own network: loopback, private ranges, link-local, .local names (a trailing dot is the same host). */
export function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || privateV4(host) || privateV6(host)
}

/**
 * The navigation rule (spec §5): http and https only, no credentials in the address, and nothing on your own network
 * (loopback, private ranges, link-local, .local names) unless allowed. A bare host gets https.
 */
export function checkUrl(input: string, o: { allowPrivate?: boolean } = {}): UrlCheck {
  const raw = input.trim()
  if (!raw) return { ok: false, reason: 'No address was given.' }
  const withScheme = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, reason: `“${raw}” is not a web address.` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'Only http and https web addresses can be opened.' }
  if (!url.hostname) return { ok: false, reason: `“${raw}” has no host.` }
  if (url.username || url.password) return { ok: false, reason: 'Addresses with a user name or password in them are not opened.' }
  const host = url.hostname.toLowerCase()
  if (privateHost(host) && !o.allowPrivate) return { ok: false, reason: `${host} is on your own network, which JevAuto does not browse.` }
  return { ok: true, url: url.href }
}
