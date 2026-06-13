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

const PORT = 4757;
const HOST = "search.library.nyu.edu";
const INST = "01NYU_INST";
const VID = "01NYU_INST:NYU";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// LC classes shelved in Bobst's open stacks, with a rough top-of-range number and
// the subject you'll find there. We weight random picks by the range size, so big
// collections (literature, law) come up proportionally more — like the real stacks.
const SHELVES = [
  // ---- Floor 4: philosophy, religion, ancient & European history (A–DS) ----
  { c: "B",  hi: 5800, s: "Philosophy" },
  { c: "BF", hi: 1990, s: "Psychology" },
  { c: "BJ", hi: 1700, s: "Ethics" },
  { c: "BL", hi: 2780, s: "Religion & Mythology" },
  { c: "BR", hi: 1725, s: "Christianity" },
  { c: "BS", hi: 2970, s: "The Bible" },
  { c: "CT", hi: 3000, s: "Biography" },
  { c: "D",  hi: 2027, s: "World History" },
  { c: "DA", hi: 995,  s: "History of Britain" },
  { c: "DC", hi: 801,  s: "History of France" },
  { c: "DD", hi: 901,  s: "History of Germany" },
  { c: "DF", hi: 951,  s: "History of Greece" },
  { c: "DG", hi: 999,  s: "History of Italy" },
  { c: "DK", hi: 949,  s: "History of Russia & Eastern Europe" },
  { c: "DS", hi: 937,  s: "History of Asia" },
  // ---- Floor 6: the Americas, Africa, geography, anthropology (DT–HA) ----
  { c: "DT", hi: 971,  s: "History of Africa" },
  { c: "E",  hi: 909,  s: "History of the United States" },
  { c: "F",  hi: 3799, s: "U.S. Local & Latin American History" },
  { c: "G",  hi: 9000, s: "Geography & Atlases" },
  { c: "GN", hi: 890,  s: "Anthropology" },
  { c: "GT", hi: 7070, s: "Manners & Customs" },
  { c: "GV", hi: 1860, s: "Recreation & Sport" },
  { c: "HA", hi: 4737, s: "Statistics" },
  // ---- Floor 7: music (M) ----
  { c: "M",  hi: 5000, s: "Music Scores" },
  { c: "ML", hi: 3930, s: "Writings on Music" },
  { c: "MT", hi: 960,  s: "Music Instruction" },
  // ---- Floor 8: literature & economics (P, HB–HJ) ----
  { c: "PA", hi: 6971, s: "Greek & Latin Literature" },
  { c: "PC", hi: 5498, s: "Romance Languages" },
  { c: "PG", hi: 7900, s: "Slavic & East European Literature" },
  { c: "PL", hi: 8844, s: "Literatures of Asia & Africa" },
  { c: "PN", hi: 6790, s: "Drama, Film & Journalism" },
  { c: "PQ", hi: 9999, s: "French, Italian & Spanish Literature" },
  { c: "PR", hi: 9680, s: "English Literature" },
  { c: "PS", hi: 3626, s: "American Literature" },
  { c: "PT", hi: 4899, s: "German & Scandinavian Literature" },
  { c: "HB", hi: 846,  s: "Economic Theory" },
  { c: "HC", hi: 1085, s: "Economic History" },
  { c: "HD", hi: 9000, s: "Industry, Labor & Land" },
  { c: "HF", hi: 6182, s: "Commerce & Business" },
  { c: "HG", hi: 9000, s: "Finance & Money" },
  // ---- Floor 9: art, science, law, sociology (HM–Z) ----
  { c: "HM", hi: 1281, s: "Sociology" },
  { c: "HN", hi: 990,  s: "Social History" },
  { c: "HQ", hi: 2044, s: "Family, Gender & Sexuality" },
  { c: "HT", hi: 1595, s: "Communities & Social Classes" },
  { c: "HV", hi: 9000, s: "Social Welfare & Criminology" },
  { c: "HX", hi: 970,  s: "Socialism & Utopias" },
  { c: "JC", hi: 628,  s: "Political Theory" },
  { c: "JK", hi: 9000, s: "U.S. Government & Politics" },
  { c: "JZ", hi: 6530, s: "International Relations" },
  { c: "K",  hi: 7000, s: "Law" },
  { c: "KF", hi: 9000, s: "U.S. Law" },
  { c: "LB", hi: 3640, s: "Education" },
  { c: "N",  hi: 9211, s: "Visual Arts" },
  { c: "NA", hi: 9428, s: "Architecture" },
  { c: "NC", hi: 1940, s: "Drawing & Design" },
  { c: "ND", hi: 3416, s: "Painting" },
  { c: "NK", hi: 8500, s: "Decorative Arts" },
  { c: "QA", hi: 939,  s: "Mathematics & Computing" },
  { c: "QB", hi: 991,  s: "Astronomy" },
  { c: "QC", hi: 999,  s: "Physics" },
  { c: "QD", hi: 999,  s: "Chemistry" },
  { c: "QE", hi: 996,  s: "Geology" },
  { c: "QH", hi: 671,  s: "Biology & Natural History" },
  { c: "QK", hi: 989,  s: "Botany" },
  { c: "QL", hi: 991,  s: "Zoology" },
  { c: "QP", hi: 981,  s: "Physiology" },
  { c: "R",  hi: 920,  s: "Medicine" },
  { c: "S",  hi: 972,  s: "Agriculture" },
  { c: "T",  hi: 995,  s: "Technology & Engineering" },
  { c: "TK", hi: 9000, s: "Electrical Engineering" },
  { c: "TR", hi: 1050, s: "Photography" },
  { c: "TX", hi: 1110, s: "Food & Home Economics" },
  { c: "U",  hi: 900,  s: "Military Science" },
  { c: "Z",  hi: 8999, s: "Books, Writing & Libraries" }
];

// cumulative weights (∝ range size) for a weighted random class pick
const TOTAL_W = SHELVES.reduce(function (a, s) { return a + s.hi; }, 0);
function pickShelfClass() {
  let r = Math.random() * TOTAL_W;
  for (const s of SHELVES) { if ((r -= s.hi) <= 0) return s; }
  return SHELVES[SHELVES.length - 1];
}

// Offline fallback shelves (used only if BobCat can't be reached).
const FALLBACK = [
  { floor: "8", cls: "PR", num: 6053, section: "PR 6053", subject: "English Literature", span: null },
  { floor: "9", cls: "QA", num: 76,   section: "QA 76",   subject: "Mathematics & Computing", span: null },
  { floor: "4", cls: "B",  num: 105,  section: "B 105",   subject: "Philosophy", span: null },
  { floor: "6", cls: "E",  num: 184,  section: "E 184",   subject: "History of the United States", span: null }
];

// Map an LC call number's leading letters to a Bobst floor (NYU's official directory).
// A–DS → 4 | DT–HA → 6 | M → 7 | P & HB–HJ → 8 | HM–HZ, J–N, Q–Z → 9
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
    return {
      floor: floorFor(seed),
      cls: sh.c,
      num: num,
      section: sh.c + " " + num,             // the shelf label, e.g. "PR 6053"
      subject: sh.s,
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

  // static: serve index.html
  fs.readFile(path.join(__dirname, "index.html"), function (err, data) {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
});

server.listen(PORT, async function () {
  console.log("\n  The Bobst Oracle is consulting the stacks.");
  try { await mintToken(); console.log("  live: random real shelves from BobCat (guest token ready)"); }
  catch (e) { console.log("  could not reach BobCat — offline fallback shelves only"); }
  console.log("  → open  http://localhost:" + PORT + "\n");
});
