// Verifies watchlist expected_origin values against RIPEstat prefix-overview.
// Usage: node scripts/verify-watchlist.mjs
// Prints the prefix, the origin AS(es) RIPEstat currently sees, and the holder name.

const candidates = [
  // 13 DNS root server prefixes (IPv4)
  ["198.41.0.0/24", "A-root DNS"],
  ["170.247.170.0/24", "B-root DNS"],
  ["192.33.4.0/24", "C-root DNS"],
  ["199.7.91.0/24", "D-root DNS"],
  ["192.203.230.0/24", "E-root DNS"],
  ["192.5.5.0/24", "F-root DNS"],
  ["192.112.36.0/24", "G-root DNS"],
  ["198.97.190.0/24", "H-root DNS"],
  ["192.36.148.0/24", "I-root DNS"],
  ["192.58.128.0/24", "J-root DNS"],
  ["193.0.14.0/24", "K-root DNS"],
  ["199.7.83.0/24", "L-root DNS"],
  ["202.12.27.0/24", "M-root DNS"],
  // Public resolvers
  ["1.1.1.0/24", "Cloudflare DNS"],
  ["1.0.0.0/24", "Cloudflare DNS (1.0.0.1)"],
  ["8.8.8.0/24", "Google DNS"],
  ["8.8.4.0/24", "Google DNS (8.8.4.4)"],
  ["9.9.9.0/24", "Quad9 DNS"],
  ["149.112.112.0/24", "Quad9 DNS (secondary)"],
  ["208.67.222.0/24", "OpenDNS"],
  ["94.140.14.0/24", "AdGuard DNS"],
  // CDN / cloud / big brands
  ["104.16.0.0/13", "Cloudflare CDN"],
  ["151.101.0.0/16", "Fastly CDN"],
  ["2.16.0.0/13", "Akamai CDN"],
  ["142.250.0.0/15", "Google services"],
  ["157.240.0.0/16", "Meta / Facebook"],
  ["129.134.30.0/24", "Facebook DNS (a.ns)"],
  ["17.0.0.0/8", "Apple"],
  ["140.82.112.0/20", "GitHub"],
  ["104.244.40.0/21", "X / Twitter"],
  ["208.80.152.0/22", "Wikimedia"],
  ["198.38.96.0/19", "Netflix"],
  ["52.94.0.0/22", "Amazon AWS"],
  ["20.190.128.0/18", "Microsoft Azure AD"],
  ["149.154.160.0/20", "Telegram"],
  ["185.199.108.0/22", "GitHub Pages"],
];

for (const [prefix, label] of candidates) {
  const url = `https://stat.ripe.net/data/prefix-overview/data.json?resource=${encodeURIComponent(prefix)}`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    const d = json.data ?? {};
    const asns = (d.asns ?? []).map((a) => `${a.asn} (${a.holder})`).join(", ") || "NONE";
    const exact = d.resource === prefix ? "" : ` [RIPEstat resolved to ${d.resource}]`;
    const announced = d.announced ? "announced" : "NOT ANNOUNCED";
    console.log(`${prefix.padEnd(20)} ${label.padEnd(28)} ${announced.padEnd(14)} origin: ${asns}${exact}`);
  } catch (e) {
    console.log(`${prefix.padEnd(20)} ${label.padEnd(28)} ERROR: ${e.message}`);
  }
  // RIPEstat asks for max ~8 req/s; stay well under
  await new Promise((r) => setTimeout(r, 250));
}
