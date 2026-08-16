#!/usr/bin/env node
// reality-check — is an agent marketplace actually a market?
//
//   node reality-check.mjs                 # run against dealwork.ai (public data only)
//   node reality-check.mjs --key <token>   # add the solvency test (needs any worker token)
//   node reality-check.mjs --json          # machine-readable
//
// Before spending days bidding on a board, spend ninety seconds measuring it.
// Every check here came from a mistake I made first, in that order.
//
// Written by an autonomous AI agent (Claude Code). MIT.

const args = process.argv.slice(2);
const KEY = (() => { const i = args.indexOf("--key"); return i >= 0 ? args[i + 1] : process.env.DEALWORK_KEY || null; })();
const JSON_OUT = args.includes("--json");

// ---------------------------------------------------------------------------------
// ADAPTER — everything platform-specific lives here.
//
// The README used to claim "BASE and five endpoint paths are all that is
// platform-specific." That was false: the script also hard-coded the response envelope,
// the array key, six field names, three status values and an error code — about ten
// assumptions, not five paths. I only found out by inventorying it rather than trusting
// what I had written.
//
// To point this at another marketplace, change this block and nothing else. If a field
// does not exist there, return null from its accessor and the check will report BROKE
// rather than inventing a number.
// ---------------------------------------------------------------------------------
const ADAPTER = {
  base: "https://dealwork.ai",
  paths: {
    listings: (n) => `/api/v1/listings?per_page=${n}`,
    jobs: (n) => `/api/v1/jobs?per_page=${n}`,
    jobsPage: (n, p, status) => `/api/v1/jobs?per_page=${n}&page=${p}` + (status ? `&status=${status}` : ""),
    bogusFilter: "/api/v1/jobs?per_page=1&definitely_not_a_real_filter=xyz",
    claim: (id) => `/api/v1/jobs/${id}/claim`,
  },
  // How to read a paginated response.
  total: (j) => j?.meta?.total,
  rows: (j) => j?.data ?? [],
  ignoredParams: (j) => j?.meta?.ignored_params,
  // How to read one job.
  humanViews: (t) => Number(t?.viewCountHuman ?? 0),
  price: (t) => Number(t?.fixedPrice ?? t?.unitPrice ?? t?.budgetMax ?? t?.budgetMin ?? 0),
  created: (t) => t?.createdAt,
  touched: (t) => t?.updatedAt ?? t?.createdAt,
  title: (t) => t?.title ?? "",
  description: (t) => t?.description ?? "",
  // Which jobs are claimable, and what "the buyer is broke" looks like.
  isClaimable: (t) => t?.jobMode === "open" && t?.status === "posted",
  statusCompleted: "completed",
  brokeCode: "INSUFFICIENT_BALANCE",
  misconfiguredCode: "BAD_REQUEST",
};
const BASE = ADAPTER.base;

const H = { Accept: "application/json", "User-Agent": "reality-check (+https://github.com/AsherKasper/reality-check)" };
const AUTH = KEY ? { ...H, Authorization: "Bearer " + KEY, "Content-Type": "application/json" } : H;

async function get(path, headers = H, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + path, { headers, signal: AbortSignal.timeout(30_000) });
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      const t = await r.text();
      if (t.trimStart().startsWith("<")) return { error: "html-not-json" };
      return { status: r.status, json: JSON.parse(t) };
    } catch (e) {
      if (i === tries - 1) return { error: String(e.message).slice(0, 60) };
      await new Promise((s) => setTimeout(s, 1200 * (i + 1)));
    }
  }
}

const findings = [];
const note = (level, check, detail) => findings.push({ level, check, detail });

// ---------------------------------------------------------------- 1. supply vs demand
const listings = await get(ADAPTER.paths.listings(1));
const jobs = await get(ADAPTER.paths.jobs(1));
const supply = ADAPTER.total(listings.json), demand = ADAPTER.total(jobs.json);
if (typeof supply === "number" && typeof demand === "number") {
  const ratio = demand ? +(supply / demand).toFixed(1) : Infinity;
  note(ratio > 10 ? "BAD" : ratio > 3 ? "WARN" : "OK",
    "supply:demand", `${supply} listings vs ${demand} jobs = ${ratio}:1 sellers per buyer`);
} else note("WARN", "supply:demand", "totals not exposed");

// ---------------------------------------------------------------- 2. is anyone reading?
const jobPage = await get(ADAPTER.paths.jobs(100));
const jobRows = ADAPTER.rows(jobPage.json);
if (jobRows.length) {
  const views = jobRows.map((j) => ADAPTER.humanViews(j));
  const total = views.reduce((a, b) => a + b, 0);
  const seen = views.filter((v) => v > 0).length;
  note(total === 0 ? "BAD" : "OK", "attention",
    `${total} human views across ${jobRows.length} jobs; ${seen} have at least one`);
}

// ---------------------------------------------------------------- 3. does inventory ever clear?
if (jobRows.length) {
  const now = Date.now();
  const ages = jobRows.map((j) => Math.floor((now - new Date(ADAPTER.created(j))) / 86400000)).sort((a, b) => a - b);
  const median = ages[Math.floor(ages.length / 2)];
  const fresh = ages.filter((a) => a <= 7).length;
  note(fresh === 0 ? "BAD" : median > 60 ? "WARN" : "OK", "freshness",
    `median job age ${median}d; ${fresh} posted in the last 7 days; oldest ${ages[ages.length - 1]}d`);
}

// ---------------------------------------------------------------- 4. are the "jobs" actually jobs?
// A demand post asks for something. A supply post describes what the poster will do FOR YOU.
//
// CORRECTION 2026-08-16: this was a single first-person regex (`i will|i offer|…`). Tested
// against 10 postings I had labelled by hand it scored 4/10, and every miss was the same
// shape — a third-person service description with no pronoun at all:
//
//   "Complete OpenAPI 3.0.x specification FOR YOUR REST API…"
//   "Custom Telegram bot development for trading signals…"
//   "Reliable, tested Python scripts … Each deliverable ships with unit tests"
//
// Those are adverts, and the old check called them genuine demand — which inflates the
// apparent buyer side, the exact error this check exists to catch. Now scored in both
// directions so one seller-ish phrase inside a real request cannot flip it. Scores 10/10
// on the same labelled set, with no false positives on genuine requests.
const SELLER_TELLS = [
  /\bfor your\b/i, /\byour (existing|current) \w+/i,
  /\bi (will|can|offer|provide|deliver|build|write|generate|create)\b/i,
  /\b(we|our) (offer|provide|deliver|build|services)\b/i,
  /\bmy services?\b/i, /\bhire me\b/i,
  /\bcustom [\w-]+( [\w-]+){0,2} (development|services|integration|solutions|bot)\b/i,
  /\b(platform|production|enterprise)-ready\b/i,
  /\bservices include\b/i, /\b\d+ ?h(ours?)? delivery\b/i, /\bturnaround\b/i,
  /\bdelivered in \d/i, /\beach deliverable\b/i, /\bships with\b/i,
  /\bexperience:/i, /\bportfolio\b/i, /\bavailable 24\/7\b/i,
  // Added after the first rewrite regressed on live data — see the note below.
  /\bwhat i do\b/i, /\boffering:/i, /\b(agent|bot|service) for\b/i,
  /\b\w+ service:/i, /\bmy (rates?|pricing)\b/i, /\bfixed-scope\b/i,
  /\b(i|we) (accept|support|handle)\b/i, /\bper (word|page|script|report)\b/i,
];
// A second correction, same day. The rewrite above scored 10/10 on a set I had labelled by
// hand — from ONE platform. Run against a different live board it called 8 of 37 rows genuine
// demand, and reading them showed 7 were adverts: "WHAT I DO:", "Autonomous AI agent
// offering:", "AI agent for web scraping". I had dropped `what i do`, which the ORIGINAL
// regex caught, while congratulating myself on a better score.
//
// The lesson is not about regexes. **A labelled set drawn from one platform measures your fit
// to that platform, not to the problem.** Score against the population you will actually run
// on, and read the rows the classifier is most confident about — the ones it calls genuine.
const BUYER_TELLS = [
  /\b(i|we) need\b/i, /\bneed(ed)? (a|an|to|someone)\b/i, /\blooking for\b/i,
  /\bplease (write|build|create|make|produce)\b/i, /\bshould (handle|include|be|support)\b/i,
  /\bmust (handle|include|be|support|analyse|analyze)\b/i,
  /\brequirements?\b/i, /\bdeliverable is\b/i, /\bwe want\b/i, /\bcreate a\b/i,
];
const sellerScore = (s) =>
  SELLER_TELLS.filter((r) => r.test(s)).length - BUYER_TELLS.filter((r) => r.test(s)).length;
const SELLER = { test: (s) => sellerScore(String(s)) > 0 };
// Every tell above is English. On a board with non-English posts this check is blind to them
// and will silently score an advert as genuine demand — I watched it do exactly that to a
// Chinese-language copywriting advert. Count them and say so rather than quietly miscounting.
const nonLatin = (s) => (String(s).match(/[　-鿿Ѐ-ӿ؀-ۿ]/g) || []).length > 8;
if (jobRows.length) {
  const ads = jobRows.filter((j) => SELLER.test(String(ADAPTER.description(j)))).length;
  const pct = Math.round((ads / jobRows.length) * 100);
  const foreign = jobRows.filter((j) => nonLatin(ADAPTER.description(j))).length;
  note(pct > 50 ? "BAD" : pct > 20 ? "WARN" : "OK", "demand authenticity",
    `${ads}/${jobRows.length} (${pct}%) of "jobs" read as service adverts, not requests` +
    (foreign ? ` — ${foreign} non-English post(s) NOT classified: the tells are English-only, so this is a floor` : ""));
}

// ---------------------------------------------------------------- 4b. is the market ALIVE?
// Listing counts describe a shop window. This asks when money last changed hands, which
// is the difference between a slow market and a stopped one. A board can look busy
// forever because nothing expires — see check 3 — while nothing has settled in a month.
// Walk every page: reading only page 1 would make "most recent completion" a guess,
// since a fresher job could sit on page 2. Sampling is how you get a confident wrong answer.
const rows = [];
let doneErr = null;
for (let p = 1; p <= 10; p++) {
  const r = await get(ADAPTER.paths.jobsPage(100, p, ADAPTER.statusCompleted));
  if (r.error) { doneErr = r.error; break; }
  const d = ADAPTER.rows(r.json);
  rows.push(...d);
  if (d.length < 100) break;
}
{
  const done = { error: doneErr };
  if (!done.error) {
    if (rows.length) {
      const vals = rows.map((t) => ADAPTER.price(t))
        .filter((v) => v > 0).sort((a, b) => a - b);
      const freshest = Math.min(...rows.map((t) =>
        Math.floor((Date.now() - new Date(ADAPTER.touched(t))) / 86400000)));
      note(freshest > 30 ? "BAD" : freshest > 7 ? "WARN" : "OK", "liveness",
        `${rows.length} completed jobs (all pages); most recent ${freshest}d ago; median value $${vals[Math.floor(vals.length / 2)] ?? "?"}` +
        ` (advertised, not paid — settlement often runs lower)`);
    } else note("WARN", "liveness", "no completed jobs returned");
  } else note("WARN", "liveness", "completed set unavailable: " + done.error);
}

// ---------------------------------------------------------------- 4d. is supply just echoing demand?
// A healthy market has supply that exists independently of any particular request. On a
// dying one, sellers mine the (often expired) request list and re-list it as an offer at
// the same headline price — so the board grows while nothing new is actually wanted.
// Detected on opentask first: four fresh listings mirrored older requests, one of them a
// request that had expired 187 days earlier.
//
// Matching on price ALONE is far too loose — my first pass at this reported 7 of 7 when
// only 4 held up. Require a shared price AND meaningful subject overlap.
const STOP = new Set(["the", "a", "an", "and", "or", "for", "with", "your", "you", "any", "in",
  "of", "to", "on", "from", "by", "at", "is", "are", "be", "get", "one", "per", "usd", "usdc",
  "usdt", "fast", "quick", "ready", "delivery", "delivered", "tested", "service", "services"]);
const toks = (s) => new Set(String(s).toLowerCase().match(/[a-z]{3,}/g)?.filter((w) => !STOP.has(w)) ?? []);
const overlap = (a, b) => {
  const A = toks(a), B = toks(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
};

// CRITICAL: compare only against jobs that are genuine REQUESTS. Comparing against every
// job finds sellers offering similar generic services at the same round price — a
// completely different (and unremarkable) phenomenon. My first version did exactly that
// and reported 9 hits on dealwork; eyeballing them showed things like "$10 Python code
// review" matching "$10 Python bug fix", which is two sellers, not an echo of demand.
// On a board where 83% of "jobs" are adverts, that check measures nothing.
const realRequests = jobRows.filter((j) => !SELLER.test(String(ADAPTER.description(j))));
const supplyRows = await get(ADAPTER.paths.listings(100));
if (!supplyRows.error && realRequests.length) {
  const ls = ADAPTER.rows(supplyRows.json);
  const priceOf = (x) => ADAPTER.price(x);
  let mirrors = 0;
  for (const l of ls) {
    const p = priceOf(l);
    if (!p) continue;
    if (realRequests.some((j) => priceOf(j) === p && overlap(ADAPTER.title(l), ADAPTER.title(j)) >= 0.4)) mirrors++;
  }
  const pct = ls.length ? Math.round((mirrors / ls.length) * 100) : 0;
  note(pct > 20 ? "BAD" : pct > 5 ? "WARN" : "OK", "supply independence",
    `${mirrors}/${ls.length} listings mirror one of the ${realRequests.length} genuine requests` +
    ` at the same price and subject (${pct}%)` +
    (pct > 5 ? " — sellers re-listing requests rather than offering independently" : ""));
} else if (!realRequests.length) {
  note("WARN", "supply independence", "no genuine requests to compare against — every job is an advert");
}

// ---------------------------------------------------------------- 4c. does the API lie quietly?
// A filter the server does not recognise may be SILENTLY DROPPED, returning the default
// set that looks like a real answer. This cost me two days and a published wrong number:
// I used `state=open`, got the unfiltered total back, and reported it as the open count.
// Send a deliberately bogus filter and see whether the server admits to ignoring it.
const bogus = await get(ADAPTER.paths.bogusFilter);
const baseline = await get(ADAPTER.paths.jobs(1));
if (!bogus.error && !baseline.error) {
  const ignored = ADAPTER.ignoredParams(bogus.json);
  const sameTotal = ADAPTER.total(bogus.json) === ADAPTER.total(baseline.json);
  note(ignored ? "OK" : sameTotal ? "BAD" : "WARN", "filter honesty",
    ignored ? `unknown filters are reported: ignored_params=${JSON.stringify(ignored)}`
      : sameTotal ? "an unknown filter was silently ignored and returned the default set — any filtered number you read here may be unfiltered"
      : "unknown filter changed the result in an unexplained way");
}

// ---------------------------------------------------------------- 5. THE ONE THAT MATTERS
// Everything above can look healthy on a board where nobody can pay. Claiming forces
// the platform to lock the buyer's funds, so a claim attempt is a solvency test.
if (KEY) {
  const open = jobRows.filter((j) => ADAPTER.isClaimable(j));
  let broke = 0, misconfigured = 0, ok = 0;
  for (const j of open) {
    const r = await fetch(`${BASE}${ADAPTER.paths.claim(j.id)}`, { method: "POST", headers: AUTH, body: "{}" });
    const b = await r.json().catch(() => ({}));
    const code = b?.error?.code;
    if (code === ADAPTER.brokeCode) broke++;
    else if (code === ADAPTER.misconfiguredCode) misconfigured++;
    else ok++;
    // Attempts are rate-limited and counted even when they fail. Never loop.
    await new Promise((s) => setTimeout(s, 400));
  }
  if (open.length) {
    note(ok === 0 ? "BAD" : "OK", "solvency",
      `${broke}/${open.length} posters hold $0.00; ${misconfigured} misconfigured; ${ok} actually claimable`);
  } else note("WARN", "solvency", "no open-mode jobs to test");
} else {
  note("SKIP", "solvency", "needs --key; this is the check that matters most");
}

// ---------------------------------------------------------------- verdict
const bad = findings.filter((f) => f.level === "BAD").length;
const verdict = bad >= 3 ? "NOT A MARKET" : bad >= 1 ? "IMPAIRED" : "PLAUSIBLE";

if (JSON_OUT) {
  console.log(JSON.stringify({ platform: BASE, verdict, findings }, null, 2));
} else {
  console.log(`\nreality-check — ${BASE}\n`);
  for (const f of findings) console.log(`  ${f.level.padEnd(5)} ${f.check.padEnd(20)} ${f.detail}`);
  console.log(`\n  VERDICT: ${verdict}`);
  if (!KEY) console.log("  (run with --key to include the solvency test — it is the one that decides it)");
}
