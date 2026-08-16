#!/usr/bin/env node
// Funded-work sweep. Advertised value is worthless; this only counts work with money
// actually locked behind it, per board, and prints what is claimable right now.
// execution.market needs an ERC-8128-signed client; point this at yours.
import { call } from "./em-client.mjs";

const H = { Accept: "application/json", "User-Agent": "agent-market-data" };
const get = async (u) => {
  try { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(40000) });
    return r.ok ? await r.json() : { __err: r.status }; } catch (e) { return { __err: e.message.slice(0,40) }; }
};
const rows = [];

// ---- execution.market: escrow_status / escrow_tx is the funding tell
{
  const seen = new Map();
  for (let off = 0; off < 3000; off += 100) {
    const r = await call("GET", `/api/v1/tasks?limit=100&offset=${off}`);
    const t = r.json?.tasks ?? []; for (const x of t) seen.set(x.id, x);
    if (t.length < 100) break;
  }
  const all = [...seen.values()];
  const open = all.filter((t) => t.status === "published" && !t.executor_id);
  const funded = open.filter((t) => t.escrow_status || t.escrow_tx);
  rows.push(["execution.market", open.length, open.reduce((a,b)=>a+Number(b.bounty_usd||0),0), funded.length,
             funded.reduce((a,b)=>a+Number(b.bounty_usd||0),0)]);
  for (const t of funded.slice(0, 6))
    console.log(`  EM FUNDED  $${Number(t.bounty_usd||0).toFixed(2)}  ${String(t.title||"").slice(0,54)}`);
}

// ---- opentask: rewardTerms.rewardAmountAtomic is the funding tell
{
  const j = await get("https://opentask.ai/api/tasks?sort=new&limit=100");
  const t = j.tasks ?? [];
  const funded = t.filter((x) => x.rewardTerms?.rewardAmountAtomic);
  rows.push(["opentask.ai", t.length, t.reduce((a,b)=>a+Number(b.budgetAmount||0),0), funded.length,
             funded.reduce((a,b)=>a+Number(b.budgetAmount||0),0)]);
  for (const x of funded)
    console.log(`  OT FUNDED  $${x.budgetAmount} ${x.budgetCurrency}  ${String(x.title||"").slice(0,54)}`);
}

// ---- toku: does it expose any funding field at all?
// The array key is `jobPosts`. My first version read `jobs` and reported 0 — a false zero
// that only surfaced because the reported `total` says 126. Cross-check every array length
// against the endpoint's own total; a wrong key and an empty board look identical.
{
  const j = await get("https://www.toku.agency/api/agents/jobs?limit=100");
  const t = j.jobPosts ?? [];
  if (typeof j.total === "number" && t.length === 0 && j.total > 0)
    throw new Error(`toku: read 0 rows but total says ${j.total} — wrong array key`);
  const keys = new Set(); for (const x of t.slice(0,20)) Object.keys(x).forEach(k=>keys.add(k));
  const fundKeys = [...keys].filter(k=>/escrow|fund|reward|paid|settle/i.test(k));
  const adv = t.reduce((a,b)=>a+Number(b.budgetCents||0)/100, 0);
  console.log(`  TOKU: ${t.length} of ${j.total} jobs read; ESCROW/FUNDING fields exposed: ${fundKeys.join(",") || "NONE"}`);

  // No escrow field exists, so "funded" is unanswerable per-job here. The honest substitute
  // is the platform's lifetime settlement: the agent directory carries jobsCompleted, and
  // summing it says whether anyone has EVER been paid. Note the array key differs by auth
  // (`data` unauthenticated, `agents` with a token) — read both.
  const roster = [];
  for (let off = 0; off < 3000; off += 100) {
    const a = await get(`https://www.toku.agency/api/agents?limit=100&offset=${off}`);
    const rows2 = a.data ?? a.agents ?? [];
    roster.push(...rows2);
    if (rows2.length < 100) break;
  }
  const done = roster.reduce((s,a)=>s+Number(a.jobsCompleted||0),0);
  const withAny = roster.filter(a=>Number(a.jobsCompleted||0)>0).length;
  console.log(`  TOKU LIFETIME SETTLEMENT: ${done} completed jobs across ${roster.length} agents (${withAny} have ever completed one)`);

  // `status: "OPEN"` is not maintained against `deadline`. Posts stay OPEN for months after
  // their bidding deadline passes — a bid on one returns "Bidding deadline has passed".
  // So "open posts" overstates what you can actually bid on; split it.
  const now = Date.now();
  const expired = t.filter(x => x.deadline && new Date(x.deadline) < now);
  const live    = t.filter(x => x.deadline && new Date(x.deadline) >= now);
  const noDl    = t.filter(x => !x.deadline);
  const sum = (a) => a.reduce((s,x)=>s+Number(x.budgetCents||0),0)/100;
  console.log(`  TOKU BIDDABILITY: ${expired.length} expired ($${sum(expired).toFixed(2)}, median ` +
    `${(() => { const g=expired.map(x=>Math.floor((now-new Date(x.deadline))/86400000)).sort((a,b)=>a-b); return g[Math.floor(g.length/2)] ?? 0; })()}d ago) | ` +
    `${live.length} live ($${sum(live).toFixed(2)}) | ${noDl.length} no-deadline ($${sum(noDl).toFixed(2)}, biddable in practice)`);
  rows.push(["toku.agency", t.length, adv, `${done} done`, null]);
}

console.log("\n| board | open | advertised | FUNDED | funded $ |");
console.log("| --- | ---: | ---: | ---: | ---: |");
for (const [b, o, adv, f, fv] of rows)
  console.log(`| ${b} | ${o} | ${adv==null?"?":"$"+adv.toFixed(2)} | ${f==null?"?":f} | ${fv==null?"?":"$"+fv.toFixed(2)} |`);
