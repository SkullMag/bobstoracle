// The Bobst Oracle — local server.
//
// It gives you a RANDOM SHELF to wander to. Each spin:
//   1. picks a random spot in the Library-of-Congress call-number space
//      (a random class + random number), weighted by how big each class is;
//   2. asks NYU's catalog (BobCat) whether Bobst actually has books shelved there,
//      so we only ever send you to a real, occupied aisle — never a gap;
//   3. returns the floor + the call-number section + what's shelved there.
//
// It does NOT pick a book. You go to the shelf and grab whatever calls to you.
//
// A guest JWT (minted below) lifts BobCat's anti-abuse rate limit so the live
// occupancy checks don't get blocked. The browser can't call BobCat directly
// (no CORS headers), which is why this little proxy exists.
//
// Run:  node server.js   →   open http://localhost:4757

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// Load .env for local development (production sets env vars via systemd)
try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/).forEach(function (line) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.+)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
} catch (e) { /* no .env file — use process environment */ }

const POSTHOG_TOKEN = process.env.POSTHOG_PROJECT_TOKEN || "";
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com";

const PORT = 4757;
const HOST = "search.library.nyu.edu";
const INST = "01NYU_INST";
const VID = "01NYU_INST:NYU";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Official Bobst call-number buckets from NYU Libraries:
// https://library.nyu.edu/services/borrowing/nyu/finding-materials-bobst-call-numbers-maps/
//
// The official table gives broad floor buckets, not exact numeric shelf spans.
// We pick one of those official buckets first, then pick a representative LC
// class/number inside that bucket and verify live Bobst holdings in BobCat.
const OFFICIAL_BUCKETS = [
  { id: "floor4-main", floor: "4", label: "A, B, C, D-DS", subject: "General Works, Philosophy, Religion & History", shelfIndexes: [] },
  { id: "floor6-main", floor: "6", label: "DT-DZ, E, F, G, H-HA", subject: "Africa, the Americas, Geography & Social Sciences", shelfIndexes: [] },
  { id: "floor7-main", floor: "7", label: "M", subject: "Music", shelfIndexes: [] },
  { id: "floor8-main", floor: "8", label: "P, HB-HJ", subject: "Literature & Economics", shelfIndexes: [] },
  { id: "floor9-main", floor: "9", label: "HM-HZ, J, K, L, N, Q, R, S, T, U, V, Z", subject: "Sociology, Law, Arts, Sciences & Technology", shelfIndexes: [] }
];

// Representative LC classes within the official buckets, with rough top-of-range
// numbers used only to generate searchable call-number seeds.
const SHELVES = [
  { c: "A",  hi: 999,  s: "General Works", g: "floor4-main" },
  { c: "B",  hi: 5800, s: "Philosophy", g: "floor4-main" },
  { c: "BF", hi: 1990, s: "Psychology", g: "floor4-main" },
  { c: "BJ", hi: 1700, s: "Ethics", g: "floor4-main" },
  { c: "BL", hi: 2780, s: "Religion & Mythology", g: "floor4-main" },
  { c: "BR", hi: 1725, s: "Christianity", g: "floor4-main" },
  { c: "BS", hi: 2970, s: "The Bible", g: "floor4-main" },
  { c: "C",  hi: 999,  s: "Auxiliary Sciences of History", g: "floor4-main" },
  { c: "CT", hi: 3000, s: "Biography", g: "floor4-main" },
  { c: "D",  hi: 2027, s: "World History", g: "floor4-main" },
  { c: "DA", hi: 995,  s: "History of Britain", g: "floor4-main" },
  { c: "DC", hi: 801,  s: "History of France", g: "floor4-main" },
  { c: "DD", hi: 901,  s: "History of Germany", g: "floor4-main" },
  { c: "DF", hi: 951,  s: "History of Greece", g: "floor4-main" },
  { c: "DG", hi: 999,  s: "History of Italy", g: "floor4-main" },
  { c: "DK", hi: 949,  s: "History of Russia & Eastern Europe", g: "floor4-main" },
  { c: "DS", hi: 937,  s: "History of Asia", g: "floor4-main" },
  { c: "DT", hi: 971,  s: "History of Africa", g: "floor6-main" },
  { c: "E",  hi: 909,  s: "History of the United States", g: "floor6-main" },
  { c: "F",  hi: 3799, s: "U.S. Local & Latin American History", g: "floor6-main" },
  { c: "G",  hi: 9000, s: "Geography & Atlases", g: "floor6-main" },
  { c: "GN", hi: 890,  s: "Anthropology", g: "floor6-main" },
  { c: "GT", hi: 7070, s: "Manners & Customs", g: "floor6-main" },
  { c: "GV", hi: 1860, s: "Recreation & Sport", g: "floor6-main" },
  { c: "HA", hi: 4737, s: "Statistics", g: "floor6-main" },
  { c: "M",  hi: 5000, s: "Music Scores", g: "floor7-main" },
  { c: "ML", hi: 3930, s: "Writings on Music", g: "floor7-main" },
  { c: "MT", hi: 960,  s: "Music Instruction", g: "floor7-main" },
  { c: "PA", hi: 6971, s: "Greek & Latin Literature", g: "floor8-main" },
  { c: "PC", hi: 5498, s: "Romance Languages", g: "floor8-main" },
  { c: "PG", hi: 7900, s: "Slavic & East European Literature", g: "floor8-main" },
  { c: "PL", hi: 8844, s: "Literatures of Asia & Africa", g: "floor8-main" },
  { c: "PN", hi: 6790, s: "Drama, Film & Journalism", g: "floor8-main" },
  { c: "PQ", hi: 9999, s: "French, Italian & Spanish Literature", g: "floor8-main" },
  { c: "PR", hi: 9680, s: "English Literature", g: "floor8-main" },
  { c: "PS", hi: 3626, s: "American Literature", g: "floor8-main" },
  { c: "PT", hi: 4899, s: "German & Scandinavian Literature", g: "floor8-main" },
  { c: "HB", hi: 846,  s: "Economic Theory", g: "floor8-main" },
  { c: "HC", hi: 1085, s: "Economic History", g: "floor8-main" },
  { c: "HD", hi: 9000, s: "Industry, Labor & Land", g: "floor8-main" },
  { c: "HF", hi: 6182, s: "Commerce & Business", g: "floor8-main" },
  { c: "HG", hi: 9000, s: "Finance & Money", g: "floor8-main" },
  { c: "HM", hi: 1281, s: "Sociology", g: "floor9-main" },
  { c: "HN", hi: 990,  s: "Social History", g: "floor9-main" },
  { c: "HQ", hi: 2044, s: "Family, Gender & Sexuality", g: "floor9-main" },
  { c: "HT", hi: 1595, s: "Communities & Social Classes", g: "floor9-main" },
  { c: "HV", hi: 9000, s: "Social Welfare & Criminology", g: "floor9-main" },
  { c: "HX", hi: 970,  s: "Socialism & Utopias", g: "floor9-main" },
  { c: "JC", hi: 628,  s: "Political Theory", g: "floor9-main" },
  { c: "JK", hi: 9000, s: "U.S. Government & Politics", g: "floor9-main" },
  { c: "JZ", hi: 6530, s: "International Relations", g: "floor9-main" },
  { c: "K",  hi: 7000, s: "Law", g: "floor9-main" },
  { c: "KF", hi: 9000, s: "U.S. Law", g: "floor9-main" },
  { c: "LB", hi: 3640, s: "Education", g: "floor9-main" },
  { c: "N",  hi: 9211, s: "Visual Arts", g: "floor9-main" },
  { c: "NA", hi: 9428, s: "Architecture", g: "floor9-main" },
  { c: "NC", hi: 1940, s: "Drawing & Design", g: "floor9-main" },
  { c: "ND", hi: 3416, s: "Painting", g: "floor9-main" },
  { c: "NK", hi: 8500, s: "Decorative Arts", g: "floor9-main" },
  { c: "QA", hi: 939,  s: "Mathematics & Computing", g: "floor9-main" },
  { c: "QB", hi: 991,  s: "Astronomy", g: "floor9-main" },
  { c: "QC", hi: 999,  s: "Physics", g: "floor9-main" },
  { c: "QD", hi: 999,  s: "Chemistry", g: "floor9-main" },
  { c: "QE", hi: 996,  s: "Geology", g: "floor9-main" },
  { c: "QH", hi: 671,  s: "Biology & Natural History", g: "floor9-main" },
  { c: "QK", hi: 989,  s: "Botany", g: "floor9-main" },
  { c: "QL", hi: 991,  s: "Zoology", g: "floor9-main" },
  { c: "QP", hi: 981,  s: "Physiology", g: "floor9-main" },
  { c: "R",  hi: 920,  s: "Medicine", g: "floor9-main" },
  { c: "S",  hi: 972,  s: "Agriculture", g: "floor9-main" },
  { c: "T",  hi: 995,  s: "Technology & Engineering", g: "floor9-main" },
  { c: "TK", hi: 9000, s: "Electrical Engineering", g: "floor9-main" },
  { c: "TR", hi: 1050, s: "Photography", g: "floor9-main" },
  { c: "TX", hi: 1110, s: "Food & Home Economics", g: "floor9-main" },
  { c: "U",  hi: 900,  s: "Military Science", g: "floor9-main" },
  { c: "Z",  hi: 8999, s: "Books, Writing & Libraries", g: "floor9-main" }
];

const BUCKET_BY_ID = Object.create(null);
for (const b of OFFICIAL_BUCKETS) BUCKET_BY_ID[b.id] = b;
for (let i = 0; i < SHELVES.length; i++) BUCKET_BY_ID[SHELVES[i].g].shelfIndexes.push(i);

// cumulative weights (∝ generated LC seed space) inside the official buckets
for (const b of OFFICIAL_BUCKETS) {
  b.weight = b.shelfIndexes.reduce(function (sum, i) { return sum + SHELVES[i].hi; }, 0);
}
const TOTAL_W = OFFICIAL_BUCKETS.reduce(function (a, b) { return a + b.weight; }, 0);
function pickShelfClass() {
  let r = Math.random() * TOTAL_W;
  for (const b of OFFICIAL_BUCKETS) {
    if ((r -= b.weight) <= 0) {
      let inner = Math.random() * b.weight;
      for (const i of b.shelfIndexes) {
        const s = SHELVES[i];
        if ((inner -= s.hi) <= 0) return s;
      }
    }
  }
  return SHELVES[OFFICIAL_BUCKETS[OFFICIAL_BUCKETS.length - 1].shelfIndexes[0]];
}

// Offline fallback shelves (used only if BobCat can't be reached).
const FALLBACK = [
  { floor: "8", cls: "PR", num: 6053, section: "PR 6053", subject: "English Literature", span: null },
  { floor: "9", cls: "QA", num: 76,   section: "QA 76",   subject: "Mathematics & Computing", span: null },
  { floor: "4", cls: "B",  num: 105,  section: "B 105",   subject: "Philosophy", span: null },
  { floor: "6", cls: "E",  num: 184,  section: "E 184",   subject: "History of the United States", span: null }
];

// Map an LC call number's leading letters to a Bobst floor per NYU's official table.
// A/B/C/D-DS → 4 | DT-DZ/E/F/G/H-HA → 6 | M → 7 | P/HB-HJ → 8 | HM-HZ/J/K/L/N/Q/R/S/T/U/V/Z → 9
function floorFor(call) {
  const m = /^([A-Z]+)/.exec(String(call).trim());
  if (!m) return null;
  const alpha = m[1], a = alpha[0], b = alpha[1] || "";
  if (a === "P") return "8";
  if (a === "M") return "7";
  if (a === "A" || a === "B" || a === "C") return "4";
  if (a === "D") return b >= "T" ? "6" : "4";
  if (a === "E" || a === "F" || a === "G") return "6";
  if (a === "H") { if (b === "A" || b === "") return "6"; if (b >= "B" && b <= "J") return "8"; return "9"; }
  if ("JKLNQRSTUVZ".indexOf(a) !== -1) return "9";
  return null;
}

// ---- guest JWT (lifts the rate limit) ----
let TOKEN = null;
function httpGet(pathAndQuery, token) {
  const headers = { "User-Agent": UA, "Accept": "application/json, text/plain, */*" };
  if (token) headers["Authorization"] = "Bearer " + token;
  return new Promise(function (resolve, reject) {
    https.get({ host: HOST, path: pathAndQuery, headers: headers }, function (res) {
      let buf = "";
      res.on("data", function (d) { buf += d; });
      res.on("end", function () { resolve({ status: res.statusCode, body: buf }); });
    }).on("error", reject);
  });
}
async function mintToken() {
  const q = "/primaws/rest/pub/institution/" + INST + "/guestJwt?lang=en&viewId=" + encodeURIComponent(VID);
  const r = await httpGet(q, null);
  if (r.status !== 200) throw new Error("mint token HTTP " + r.status);
  TOKEN = r.body.trim().replace(/^"|"$/g, "");
  return TOKEN;
}

function searchPath(callSeed) {
  const params = new URLSearchParams({
    inst: INST, lang: "en", limit: "50", offset: "0",
    q: "any,contains," + callSeed, qInclude: "facet_rtype,exact,books",
    scope: "MyInst_and_CI", tab: "LibraryCatalog", vid: VID,
    sort: "rank", pcAvailability: "false", mode: "advanced"
  });
  return "/primaws/rest/pub/pnxs?" + params.toString();
}

async function primoSearch(callSeed) {
  if (!TOKEN) await mintToken();
  let r = await httpGet(searchPath(callSeed), TOKEN);
  if (r.status === 401 || r.status === 403) { await mintToken(); r = await httpGet(searchPath(callSeed), TOKEN); }
  if (r.status !== 200) throw new Error("HTTP " + r.status);
  return JSON.parse(r.body);
}

// Real Bobst Main-Collection call numbers that sit in the EXACT seed section
// (e.g. seed "B526" matches "B526 .S73" but not "BT1319 .B526" or "B5267 ...").
function bobstCallsAtSeed(data, seed) {
  const re = new RegExp("^" + seed + "(?![0-9])");   // class+number, not a longer number
  const out = [];
  for (const d of (data.docs || [])) {
    for (const h of (d.delivery && d.delivery.holding) || []) {
      if (h.libraryCode === "BOBST" &&
          /Main Collection/i.test(h.subLocation || "") &&
          h.callNumber) {
        const norm = String(h.callNumber).replace(/\s+/g, "").toUpperCase();
        if (re.test(norm)) out.push(String(h.callNumber).trim());
      }
    }
  }
  return out;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Pick a random, real, occupied Bobst shelf. Returns null only if BobCat is down.
async function getShelf() {
  for (let attempt = 0; attempt < 22; attempt++) {
    const sh = pickShelfClass();
    const num = 1 + Math.floor(Math.random() * sh.hi);
    const seed = sh.c + num;                 // e.g. "PR6053"
    let data;
    try { data = await primoSearch(seed); }
    catch (e) { await sleep(250); continue; }

    const calls = bobstCallsAtSeed(data, seed);
    if (calls.length < 2) continue;          // empty/sparse spot → re-roll

    calls.sort();
    const bucket = BUCKET_BY_ID[sh.g];
    return {
      floor: bucket.floor,
      cls: sh.c,
      num: num,
      section: sh.c + " " + num,             // the shelf label, e.g. "PR 6053"
      subject: sh.s,
      officialRange: bucket.label,
      officialSubject: bucket.subject,
      span: [calls[0], calls[calls.length - 1]],
      nearby: calls.length
    };
  }
  return null;
}

const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, "http://localhost");
  if (req.url === "/api/shelf") {
    try {
      let shelf = await getShelf();
      if (!shelf) shelf = FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(shelf));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  }

  if (url.pathname === "/favicon.ico") {
    res.writeHead(302, { "Location": "/favicon.svg", "Cache-Control": "public, max-age=86400" });
    return res.end();
  }

  if (url.pathname === "/favicon.svg") {
    fs.readFile(path.join(__dirname, "favicon.svg"), function (err, data) {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=86400" });
      res.end(data);
    });
    return;
  }

  if (url.pathname === "/robots.txt" || url.pathname === "/sitemap.xml") {
    const file = url.pathname.slice(1);
    const type = file === "robots.txt" ? "text/plain; charset=utf-8" : "application/xml; charset=utf-8";
    fs.readFile(path.join(__dirname, file), function (err, data) {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=3600" });
      res.end(data);
    });
    return;
  }

  // static: serve index.html with PostHog config injected
  fs.readFile(path.join(__dirname, "index.html"), function (err, data) {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const html = data.toString()
      .replace(/__POSTHOG_TOKEN__/g, POSTHOG_TOKEN)
      .replace(/__POSTHOG_HOST__/g, POSTHOG_HOST);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
});

server.listen(PORT, async function () {
  console.log("\n  The Bobst Oracle is consulting the stacks.");
  try { await mintToken(); console.log("  live: random real shelves from BobCat (guest token ready)"); }
  catch (e) { console.log("  could not reach BobCat — offline fallback shelves only"); }
  console.log("  → open  http://localhost:" + PORT + "\n");
});
