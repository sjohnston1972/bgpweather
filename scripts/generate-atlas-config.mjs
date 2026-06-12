// Curates the RIPE Atlas measurement set for the latency channel. Run locally
// with Node (never in the Worker): picks 2 anchors per region, resolves each
// anchor's IPv4 anchoring-mesh ping measurement, samples ~80 reporting probe
// ids to keep poll payloads small, and writes:
//   atlas-measurements.json   (repo root — imported by the LatencyWatcher DO)
//   public/regions.json       (served to the dashboard for the globe cells)
//   test/atlas-latest.fixture.json (one real trimmed /latest/ response)
// Re-run occasionally if sample counts decay (probes churn).
import { writeFileSync } from "node:fs";

const API = "https://atlas.ripe.net/api/v2";
const PROBE_SAMPLE = 80;

// Region definitions: country pools (US split by longitude), display name,
// and a rendering radius in degrees for the globe cell.
const REGIONS = {
  "uk-ireland":  { name: "UK & Ireland",   countries: ["GB", "IE"], radius: 5 },
  "west-europe": { name: "Western Europe", countries: ["NL", "DE", "FR", "BE"], radius: 6 },
  "nordics":     { name: "Nordics",        countries: ["SE", "NO", "DK", "FI"], radius: 7 },
  "east-europe": { name: "Eastern Europe", countries: ["PL", "CZ", "RO", "HU"], radius: 7 },
  "south-europe":{ name: "Southern Europe",countries: ["IT", "ES", "PT", "GR"], radius: 7 },
  "us-east":     { name: "US East",        countries: ["US"], lngMax: -100, lngTest: (lng) => lng > -100, radius: 9 },
  "us-west":     { name: "US West",        countries: ["US"], lngTest: (lng) => lng <= -100, radius: 9 },
  "brazil":      { name: "Brazil",         countries: ["BR"], radius: 9 },
  "south-africa":{ name: "South Africa",   countries: ["ZA"], radius: 7 },
  "middle-east": { name: "Middle East",    countries: ["AE", "QA", "BH", "OM", "KW"], radius: 8 },
  "india":       { name: "India",          countries: ["IN"], radius: 9 },
  "se-asia":     { name: "Southeast Asia", countries: ["SG", "MY", "TH", "ID"], radius: 9 },
  "japan-korea": { name: "Japan & Korea",  countries: ["JP", "KR"], radius: 8 },
  "australia":   { name: "Australia & NZ", countries: ["AU", "NZ"], radius: 11 },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// 1. All live anchors (paginated).
let anchors = [];
let url = `${API}/anchors/?page_size=500&include=`;
while (url) {
  const page = await get(url);
  anchors.push(...page.results);
  url = page.next;
  await sleep(200);
}
anchors = anchors.filter((a) => !a.is_disabled && !a.date_decommissioned && a.ip_v4 && a.geometry);
console.log(`live anchors: ${anchors.length}`);

// 2. Pick 2 per region (prefer longest-lived = most stable).
const chosen = [];
for (const [regionId, def] of Object.entries(REGIONS)) {
  const candidates = anchors
    .filter((a) => def.countries.includes(a.country))
    .filter((a) => !def.lngTest || def.lngTest(a.geometry.coordinates[0]))
    .sort((a, b) => (a.date_live ?? "").localeCompare(b.date_live ?? ""));
  // spread across different countries/cities where possible
  const picks = [];
  for (const a of candidates) {
    if (picks.length >= 2) break;
    if (picks.some((p) => p.city === a.city)) continue;
    picks.push(a);
  }
  if (picks.length < 2) console.warn(`${regionId}: only ${picks.length} anchors found`);
  for (const a of picks) chosen.push({ regionId, anchor: a });
}

// 3. Resolve each anchor's IPv4 anchoring-mesh ping measurement + probe sample.
const measurements = [];
let fixtureSaved = false;
for (const { regionId, anchor } of chosen) {
  await sleep(300);
  const search = await get(`${API}/measurements/?type=ping&status=2&target_ip=${anchor.ip_v4}&page_size=10`);
  const mesh = search.results.find((m) => m.af === 4 && m.description?.startsWith("Anchoring Mesh Measurement: Ping IPv4"));
  if (!mesh) { console.warn(`no mesh measurement for ${anchor.fqdn}`); continue; }

  await sleep(300);
  const latest = await get(`${API}/measurements/${mesh.id}/latest/?format=json`);
  const nowS = Date.now() / 1000;
  const fresh = latest.filter((r) => nowS - (r.timestamp ?? 0) < 600);
  // Spread the sample across the probe-id space rather than taking the first N.
  const sorted = fresh.map((r) => r.prb_id).sort((a, b) => a - b);
  const stride = Math.max(1, Math.floor(sorted.length / PROBE_SAMPLE));
  const probeIds = [...new Set(sorted.filter((_, i) => i % stride === 0))].slice(0, PROBE_SAMPLE);

  if (!fixtureSaved && fresh.length > 20) {
    // Trimmed real response for unit tests: a few successes + a loss if present.
    const losses = fresh.filter((r) => (r.avg ?? -1) < 0).slice(0, 2);
    writeFileSync("test/atlas-latest.fixture.json", JSON.stringify([...fresh.slice(0, 10), ...losses], null, 1));
    fixtureSaved = true;
  }

  measurements.push({
    msmId: mesh.id,
    region: regionId,
    anchor: anchor.fqdn,
    city: anchor.city,
    country: anchor.country,
    lat: +anchor.geometry.coordinates[1].toFixed(2),
    lng: +anchor.geometry.coordinates[0].toFixed(2),
    target: anchor.ip_v4,
    probeIds,
  });
  console.log(`${regionId}: ${anchor.fqdn} msm=${mesh.id} fresh=${fresh.length} sampled=${probeIds.length}`);
}

// 4. Region metadata for rendering: centroid of its anchors.
const regions = {};
for (const [regionId, def] of Object.entries(REGIONS)) {
  const ms = measurements.filter((m) => m.region === regionId);
  if (ms.length === 0) continue;
  regions[regionId] = {
    name: def.name,
    lat: +(ms.reduce((s, m) => s + m.lat, 0) / ms.length).toFixed(2),
    lng: +(ms.reduce((s, m) => s + m.lng, 0) / ms.length).toFixed(2),
    radius: def.radius,
  };
}

writeFileSync("atlas-measurements.json", JSON.stringify(measurements, null, 1));
writeFileSync("public/regions.json", JSON.stringify(regions, null, 1));
console.log(`atlas-measurements.json: ${measurements.length} measurements, regions.json: ${Object.keys(regions).length} regions`);
