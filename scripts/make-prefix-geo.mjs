// Generates public/prefix-geo.json: watchlist prefix -> approximate "home"
// lat/lng, looked up ONCE at build time via RIPEstat's MaxMind GeoLite data
// and baked into the repo — the dashboard never calls a geo API at runtime.
// Anycast prefixes geolocate arbitrarily; OVERRIDES pins those to the
// operator's spiritual home so the globe tells a sensible story.
import { readFileSync, writeFileSync } from "node:fs";

const watchlist = JSON.parse(readFileSync("watchlist.json", "utf8"));

// Anycast / global prefixes: pin to operator HQ rather than a random node.
const OVERRIDES = {
  "1.1.1.0/24":      { lat: 37.77, lng: -122.42, city: "San Francisco (Cloudflare HQ)" },
  "1.0.0.0/24":      { lat: 37.77, lng: -122.42, city: "San Francisco (Cloudflare HQ)" },
  "104.16.0.0/20":   { lat: 37.77, lng: -122.42, city: "San Francisco (Cloudflare HQ)" },
  "8.8.8.0/24":      { lat: 37.42, lng: -122.08, city: "Mountain View (Google HQ)" },
  "8.8.4.0/24":      { lat: 37.42, lng: -122.08, city: "Mountain View (Google HQ)" },
  "142.250.0.0/15":  { lat: 37.42, lng: -122.08, city: "Mountain View (Google HQ)" },
  "9.9.9.0/24":      { lat: 47.61, lng: -122.33, city: "Quad9 (Zurich/Seattle)" },
  "149.112.112.0/24":{ lat: 47.38, lng: 8.54,    city: "Zurich (Quad9)" },
  "198.41.0.0/24":   { lat: 38.95, lng: -77.36,  city: "Reston VA (Verisign)" },
  "192.58.128.0/24": { lat: 38.95, lng: -77.36,  city: "Reston VA (Verisign)" },
  "193.0.14.0/24":   { lat: 52.37, lng: 4.90,    city: "Amsterdam (RIPE NCC)" },
  "199.7.83.0/24":   { lat: 34.05, lng: -118.24, city: "Los Angeles (ICANN)" },
  "202.12.27.0/24":  { lat: 35.69, lng: 139.69,  city: "Tokyo (WIDE)" },
  "192.36.148.0/24": { lat: 59.33, lng: 18.06,   city: "Stockholm (Netnod)" },
  "170.247.170.0/24":{ lat: 34.02, lng: -118.29, city: "Los Angeles (USC-ISI)" },
  "192.33.4.0/24":   { lat: 38.91, lng: -77.04,  city: "Washington DC (Cogent)" },
  "199.7.91.0/24":   { lat: 38.99, lng: -76.94,  city: "College Park MD (UMD)" },
  "192.203.230.0/24":{ lat: 34.20, lng: -118.17, city: "Pasadena (NASA)" },
  "192.5.5.0/24":    { lat: 37.76, lng: -122.45, city: "San Francisco (ISC)" },
  "192.112.36.0/24": { lat: 39.01, lng: -77.50,  city: "Virginia (US DoD)" },
  "198.97.190.0/24": { lat: 39.47, lng: -76.16,  city: "Aberdeen MD (US Army)" },
  "151.101.0.0/16":  { lat: 37.77, lng: -122.42, city: "San Francisco (Fastly)" },
  "185.199.108.0/22":{ lat: 37.77, lng: -122.42, city: "San Francisco (GitHub Pages)" },
  "140.82.112.0/20": { lat: 37.77, lng: -122.42, city: "San Francisco (GitHub)" },
  "2.16.0.0/13":     { lat: 42.36, lng: -71.06,  city: "Cambridge MA (Akamai)" },
  "157.240.0.0/17":  { lat: 37.48, lng: -122.15, city: "Menlo Park (Meta)" },
  "129.134.30.0/24": { lat: 37.48, lng: -122.15, city: "Menlo Park (Meta)" },
  "17.0.0.0/8":      { lat: 37.33, lng: -122.01, city: "Cupertino (Apple)" },
  "104.244.42.0/24": { lat: 37.78, lng: -122.40, city: "San Francisco (X)" },
  "208.80.154.0/23": { lat: 37.79, lng: -122.40, city: "San Francisco (Wikimedia)" },
  "198.38.96.0/19":  { lat: 37.26, lng: -121.96, city: "Los Gatos (Netflix)" },
  "52.94.0.0/22":    { lat: 47.61, lng: -122.33, city: "Seattle (Amazon)" },
  "13.107.42.0/24":  { lat: 47.64, lng: -122.13, city: "Redmond (Microsoft)" },
  "149.154.160.0/22":{ lat: 25.20, lng: 55.27,   city: "Dubai (Telegram)" },
  "94.140.14.0/24":  { lat: 35.17, lng: 33.36,   city: "Nicosia (AdGuard)" },
  "208.67.222.0/24": { lat: 37.77, lng: -122.42, city: "San Francisco (OpenDNS)" },
};

const out = {};
for (const entry of watchlist) {
  if (OVERRIDES[entry.prefix]) {
    out[entry.prefix] = OVERRIDES[entry.prefix];
    continue;
  }
  // Fallback: ask RIPEstat's MaxMind GeoLite mirror (build time only).
  const url = `https://stat.ripe.net/data/maxmind-geo-lite/data.json?resource=${encodeURIComponent(entry.prefix)}`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    const loc = json?.data?.located_resources?.[0]?.locations?.[0];
    if (loc?.latitude != null) {
      out[entry.prefix] = { lat: +loc.latitude.toFixed(2), lng: +loc.longitude.toFixed(2), city: loc.city || loc.country || "?" };
      console.log(`${entry.prefix} -> ${out[entry.prefix].city} (RIPEstat)`);
    } else {
      console.warn(`${entry.prefix}: no location found — add an override`);
    }
  } catch (e) {
    console.warn(`${entry.prefix}: lookup failed (${e.message}) — add an override`);
  }
  await new Promise((r) => setTimeout(r, 300));
}

writeFileSync("public/prefix-geo.json", JSON.stringify(out, null, 1));
console.log(`public/prefix-geo.json: ${Object.keys(out).length} prefixes`);
