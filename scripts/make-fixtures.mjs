// Generates the three replay fixtures. These are HAND-AUTHORED RECONSTRUCTIONS
// of famous incidents — message-level details are invented to match the shape
// of what RIS would have shown, not copies of real captures.
import { mkdirSync, writeFileSync } from "node:fs";

const PEERS = Array.from({ length: 16 }, (_, i) => ({
  peer: `192.0.2.${i + 1}`,
  peer_asn: String(64500 + i),
  host: `rrc${String(i % 11).padStart(2, "0")}`,
}));

function msg(dt, peerIdx, data) {
  const p = PEERS[peerIdx % PEERS.length];
  return { dt, data: { timestamp: dt / 1000, type: "UPDATE", ...p, ...data } };
}
function ann(dt, peerIdx, prefixes, path) {
  return msg(dt, peerIdx, { path, announcements: [{ next_hop: "192.0.2.254", prefixes }] });
}
function wd(dt, peerIdx, prefixes) {
  return msg(dt, peerIdx, { withdrawals: prefixes });
}

// --- (a) Facebook, October 2021: BGP withdrawals took facebook.com's DNS off the internet.
const fb = {
  name: "facebook-2021",
  title: "Facebook outage — October 2021",
  description:
    "Facebook's backbone maintenance went wrong and BGP withdrew the routes to its authoritative DNS servers, taking facebook.com, Instagram and WhatsApp offline for six hours.",
  disclaimer: "Hand-authored reconstruction — timings and peers are illustrative, not a real capture.",
  speed: 20,
  watchlist: [
    { prefix: "129.134.30.0/24", expected_origins: [32934], label: "Facebook DNS (a.ns)" },
    { prefix: "129.134.31.0/24", expected_origins: [32934], label: "Facebook DNS (b.ns)" },
  ],
  messages: [],
};
// A quiet morning: normal announcements establish the picture.
for (let i = 0; i < 6; i++) {
  fb.messages.push(ann(i * 5000, i, ["129.134.30.0/24"], [64500 + i, 3356, 32934]));
  fb.messages.push(ann(i * 5000 + 1000, i, ["129.134.31.0/24"], [64500 + i, 174, 32934]));
}
// 15:39 UTC: the withdrawals sweep across every peer in under a minute (fixture time).
for (let i = 0; i < 16; i++) {
  fb.messages.push(wd(60_000 + i * 2500, i, ["129.134.30.0/24"]));
  fb.messages.push(wd(61_000 + i * 2500, i, ["129.134.31.0/24"]));
}
// Hours later (compressed): routes return.
for (let i = 0; i < 6; i++) {
  fb.messages.push(ann(150_000 + i * 4000, i, ["129.134.30.0/24", "129.134.31.0/24"], [64500 + i, 3356, 32934]));
}

// --- (b) YouTube, February 2008: Pakistan Telecom announces a more-specific /24.
const yt = {
  name: "youtube-2008",
  title: "YouTube hijack — February 2008",
  description:
    "Pakistan Telecom (AS17557) announced 208.65.153.0/24 — a more-specific of YouTube's /22 — intended as a domestic block. It leaked worldwide via AS3491 and took YouTube offline for most of the internet for two hours.",
  disclaimer: "Hand-authored reconstruction — timings and peers are illustrative, not a real capture.",
  speed: 20,
  watchlist: [{ prefix: "208.65.152.0/22", expected_origins: [36561], label: "YouTube" }],
  messages: [],
};
// Baseline: YouTube's /22 announced normally.
for (let i = 0; i < 5; i++) {
  yt.messages.push(ann(i * 4000, i, ["208.65.152.0/22"], [64500 + i, 3356, 36561]));
}
// 18:47 UTC: the hijack — a more-specific /24 from AS17557 via AS3491 spreads peer to peer.
for (let i = 0; i < 12; i++) {
  yt.messages.push(ann(30_000 + i * 3000, i, ["208.65.153.0/24"], [64500 + i, 3491, 17557]));
}
// ~20:07: YouTube fights back, announcing the same /24 itself (a more-specific battle).
for (let i = 0; i < 5; i++) {
  yt.messages.push(ann(90_000 + i * 3000, i, ["208.65.153.0/24"], [64500 + i, 3356, 36561]));
}
// ~21:01: PCCW de-peers Pakistan Telecom; the rogue route is withdrawn everywhere.
for (let i = 0; i < 12; i++) {
  yt.messages.push(wd(140_000 + i * 2000, i, ["208.65.153.0/24"]));
}

// --- (c) June 2019: a BGP optimizer's fake more-specifics leak through a steel mill to Verizon.
const leak = {
  name: "prepend-leak-2019",
  title: "Route-optimizer leak — June 2019",
  description:
    "A BGP optimizer at a small Pennsylvania ISP generated fake more-specifics of Cloudflare prefixes; a customer — a steel company, AS396531 — leaked them to Verizon (AS701), which propagated them worldwide. Long, strange AS paths and rerouted traffic everywhere.",
  disclaimer: "Hand-authored reconstruction — timings and peers are illustrative, not a real capture.",
  speed: 20,
  watchlist: [{ prefix: "104.16.0.0/20", expected_origins: [13335], label: "Cloudflare CDN" }],
  messages: [],
};
// Baseline: 24 normal announcements settle the path-length EWMA around 3 hops.
for (let i = 0; i < 24; i++) {
  leak.messages.push(ann(i * 2000, i, ["104.16.0.0/20"], [64500 + (i % 16), 174, 13335]));
}
// The leak: more-specifics appear (severity 2 — same origin, could be traffic engineering...).
for (let i = 0; i < 4; i++) {
  leak.messages.push(ann(60_000 + i * 3000, i, [`104.16.${i * 4}.0/22`], [64500 + i, 701, 396531, 33154, 3356, 13335]));
}
// ...and the watched /20 itself arrives with an absurd prepended path (PATH_ANOMALY by length).
leak.messages.push(ann(80_000, 2, ["104.16.0.0/20"], [64502, 701, 396531, 33154, 33154, 33154, 33154, 3356, 3356, 13335]));
// One path with a non-consecutive repeat (poisoning-style anomaly).
leak.messages.push(ann(95_000, 3, ["104.16.0.0/20"], [64503, 701, 396531, 701, 3356, 13335]));
// Recovery: normal paths return.
for (let i = 0; i < 5; i++) {
  leak.messages.push(ann(120_000 + i * 2000, i, ["104.16.0.0/20"], [64500 + i, 174, 13335]));
}

mkdirSync("fixtures", { recursive: true });
for (const f of [fb, yt, leak]) {
  writeFileSync(`fixtures/${f.name}.json`, JSON.stringify(f, null, 1));
  console.log(`fixtures/${f.name}.json: ${f.messages.length} messages`);
}
