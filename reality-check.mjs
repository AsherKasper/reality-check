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
const BASE = "https://dealwork.ai";

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
const listings = await get("/api/v1/listings?per_page=1");
const jobs = await get("/api/v1/jobs?per_page=1");
const supply = listings.json?.meta?.total, demand = jobs.json?.meta?.total;
if (typeof supply === "number" && typeof demand === "number") {
  const ratio = demand ? +(supply / demand).toFixed(1) : Infinity;
  note(ratio > 10 ? "BAD" : ratio > 3 ? "WARN" : "OK",
    "supply:demand", `${supply} listings vs ${demand} jobs = ${ratio}:1 sellers per buyer`);
} else note("WARN", "supply:demand", "totals not exposed");

// ---------------------------------------------------------------- 2. is anyone reading?
const jobPage = await get("/api/v1/jobs?per_page=100");
const jobRows = jobPage.json?.data ?? [];
if (jobRows.length) {
  const views = jobRows.map((j) => j.viewCountHuman ?? 0);
  const total = views.reduce((a, b) => a + b, 0);
  const seen = views.filter((v) => v > 0).length;
  note(total === 0 ? "BAD" : "OK", "attention",
    `${total} human views across ${jobRows.length} jobs; ${seen} have at least one`);
}

// ---------------------------------------------------------------- 3. does inventory ever clear?
if (jobRows.length) {
  const now = Date.now();
  const ages = jobRows.map((j) => Math.floor((now - new Date(j.createdAt)) / 86400000)).sort((a, b) => a - b);
  const median = ages[Math.floor(ages.length / 2)];
  const fresh = ages.filter((a) => a <= 7).length;
  note(fresh === 0 ? "BAD" : median > 60 ? "WARN" : "OK", "freshness",
    `median job age ${median}d; ${fresh} posted in the last 7 days; oldest ${ages[ages.length - 1]}d`);
}

// ---------------------------------------------------------------- 4. are the "jobs" actually jobs?
// A demand post asks for something. A supply post describes what the poster will do.
const SELLER = /\b(i will|i can |i offer|i provide|i deliver|i build|i write|i review|i audit|my services?|hire me|turnaround|available 24\/7|what i do)\b/i;
if (jobRows.length) {
  const ads = jobRows.filter((j) => SELLER.test(String(j.description || ""))).length;
  const pct = Math.round((ads / jobRows.length) * 100);
  note(pct > 50 ? "BAD" : pct > 20 ? "WARN" : "OK", "demand authenticity",
    `${ads}/${jobRows.length} (${pct}%) of "jobs" read as service adverts, not requests`);
}

// ---------------------------------------------------------------- 5. THE ONE THAT MATTERS
// Everything above can look healthy on a board where nobody can pay. Claiming forces
// the platform to lock the buyer's funds, so a claim attempt is a solvency test.
if (KEY) {
  const open = jobRows.filter((j) => j.jobMode === "open" && j.status === "posted");
  let broke = 0, misconfigured = 0, ok = 0;
  for (const j of open) {
    const r = await fetch(`${BASE}/api/v1/jobs/${j.id}/claim`, { method: "POST", headers: AUTH, body: "{}" });
    const b = await r.json().catch(() => ({}));
    const code = b?.error?.code;
    if (code === "INSUFFICIENT_BALANCE") broke++;
    else if (code === "BAD_REQUEST") misconfigured++;
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
