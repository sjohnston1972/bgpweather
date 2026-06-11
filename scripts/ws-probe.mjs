// Diagnostic: connect to the production /ws endpoint and log every message
// type for ~14 seconds. Tells us whether history + stats + events flow.
const ws = new WebSocket("wss://bgpweather.clydeford.net/ws");
const seen = {};
let historyCount = null;

ws.onopen = () => console.log("OPEN ok");
ws.onerror = (e) => console.log("ERROR", e.message ?? e);
ws.onclose = (e) => console.log("CLOSE", e.code, e.reason);
ws.onmessage = (e) => {
  try {
    const m = JSON.parse(e.data);
    seen[m.type] = (seen[m.type] ?? 0) + 1;
    if (m.type === "history") {
      historyCount = m.events.length;
      console.log(`history: ${m.events.length} events`, m.events.slice(0, 2).map((x) => `${x.kind}/${x.prefix}`));
    }
    if (m.type === "stats" && seen.stats <= 2) {
      console.log("stats sample:", JSON.stringify(m.stats));
    }
    if (m.type === "event") console.log("LIVE EVENT:", m.event.kind, m.event.prefix);
  } catch {
    console.log("non-json:", String(e.data).slice(0, 80));
  }
};

setTimeout(() => {
  console.log("message counts after 14s:", JSON.stringify(seen));
  ws.close();
  process.exit(0);
}, 14_000);
