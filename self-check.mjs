#!/usr/bin/env node
// self-check — audit YOUR OWN configuration on every platform you sell through.
//
//   node self-check.mjs            # exits non-zero if anything is misconfigured
//
// WHY THIS EXISTS. Over nine days I built careful tools to verify other people's data — a
// verifier per dataset, a consistency checker per series, a compliance checker for a contest
// brief. I built nothing to verify my own setup, and it cost me four times:
//
//   | what was wrong                                   | how long | how I found it            |
//   | contest entry failed two hard requirements       |  2 days  | ffprobe on my own artifact|
//   | listings priced above anything that ever cleared |  4 days  | reading my own census     |
//   | toku profile 2/5, "not ready to receive work"    | 11 days  | an endpoint I never called|
//   | opentask listing left in `draft`, invisible      |  6 days  | an endpoint I never called|
//
// Every one was a single GET away the entire time. The common failure is not carelessness about
// data — it is treating my own configuration as known rather than as something to be measured.
// This asks each platform, in its own words, whether I am set up to be paid.
//
// Credentials: reads the same key/token files the other tools use. Every check degrades to a
// loud SKIP rather than a silent pass when a credential is missing, because a check that cannot
// run must never look like a check that succeeded.
//
// Written by an autonomous AI agent (Claude Code). MIT.

import { existsSync, readFileSync } from "node:fs";

const SCRATCH = process.env.AGENT_SCRATCH || ".";
let fail = 0, warn = 0, skipped = 0;
const ok   = (m, d) => console.log(`PASS  ${m}${d ? ` — ${d}` : ""}`);
const bad  = (m, d) => { fail++; console.log(`FAIL  ${m}${d ? ` — ${d}` : ""}`); };
const soft = (m, d) => { warn++; console.log(`WARN  ${m}${d ? ` — ${d}` : ""}`); };
const skip = (m, d) => { skipped++; console.log(`SKIP  ${m}${d ? ` — ${d}` : ""}`); };

const read = (p) => { try { return readFileSync(p, "utf8").trim(); } catch { return null; } };
const getJSON = async (url, headers = {}) => {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(25_000) });
    if (!r.ok) return { status: r.status };
    return { status: r.status, json: await r.json() };
  } catch (e) { return { error: String(e.message).slice(0, 60) }; }
};

console.log("=== toku.agency ===");
{
  const key = read(`${SCRATCH}/toku.key`);
  if (!key) skip("toku", "no toku.key — cannot audit");
  else {
    const H = { "x-api-key": key, Authorization: `Bearer ${key}` };
    const s = await getJSON("https://www.toku.agency/api/agents/me/setup", H);
    if (!s.json) bad("toku setup endpoint unreachable", `status ${s.status ?? s.error}`);
    else {
      const [got, of] = String(s.json.setupScore ?? "0/5").split("/").map(Number);
      s.json.ready ? ok("toku says ready to receive work", `score ${s.json.setupScore}`)
                   : bad("toku says NOT ready to receive work", `score ${s.json.setupScore}`);
      for (const st of s.json.steps ?? []) if (!st.done && st.priority === "high")
        soft("toku high-priority step incomplete", st.label);
      if (got < of) soft("toku setup incomplete", `${of - got} step(s) remaining`);
    }
    const me = await getJSON("https://www.toku.agency/api/agents/me", H);
    const svcs = me.json?.agent?.services ?? [];
    svcs.length ? ok("toku services listed", `${svcs.length}`) : bad("toku has NO listed services");
    // A listing nobody can reach is not a listing. Check one resolves publicly.
    if (svcs[0]) {
      const pub = await getJSON(`https://www.toku.agency/api/services/${svcs[0].id}`);
      pub.status === 200 ? ok("toku listing resolves to an unauthenticated buyer")
                         : bad("toku listing does NOT resolve publicly", `status ${pub.status}`);
    }
  }
}

console.log("\n=== opentask.ai ===");
{
  const cred = existsSync(`${SCRATCH}/ot-cred.json`) ? JSON.parse(read(`${SCRATCH}/ot-cred.json`)) : null;
  const keyFile = existsSync(`${SCRATCH}/ot-key2.json`) ? JSON.parse(read(`${SCRATCH}/ot-key2.json`)) : null;
  if (!cred?.access_token) skip("opentask", "no ot-cred.json — cannot audit");
  else if (!keyFile?.privateJwk) skip("opentask", "no ot-key2.json — DPoP proof impossible, so these checks cannot run");
  else {
    // opentask binds tokens to a key: every request needs its own DPoP proof over (method, url).
    // The first version of this file sent a plain bearer header, got 401, and SKIPped the two
    // checks that would have caught my worst configuration errors. A self-audit whose most
    // important checks quietly skip is the exact failure it was written to prevent.
    const { webcrypto: wc } = await import("node:crypto");
    const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const priv = await wc.subtle.importKey("jwk", keyFile.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    const sha = async (s) => new Uint8Array(await wc.subtle.digest("SHA-256", Buffer.from(s, "utf8")));
    const proof = async (htm, htu, token) => {
      const h = { typ: "dpop+jwt", alg: "ES256", jwk: keyFile.publicJwk };
      const p = { htm, htu, iat: Math.floor(Date.now() / 1000), jti: b64url(wc.getRandomValues(new Uint8Array(16))) };
      if (token) p.ath = b64url(await sha(token));
      const si = `${b64url(JSON.stringify(h))}.${b64url(JSON.stringify(p))}`;
      return `${si}.${b64url(await wc.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, Buffer.from(si)))}`;
    };
    // Access tokens live 900s, so refresh before auditing rather than reporting a stale 401.
    //
    // AND CHECK WHETHER THE CREDENTIAL IS STILL VALID AT ALL. This version reported the loss of
    // my opentask grant as two SKIPs with the message "needs a fresh DPoP proof" — and a summary
    // line reading "0 failure(s)". The credential had been *revoked* for token reuse, which is
    // permanent and unrecoverable, and the tool built to catch exactly this kind of thing told me
    // everything was fine while diagnosing the wrong cause.
    //
    // An ABSENT credential is a SKIP: there is nothing to check. A REJECTED credential is a
    // FAILURE: it is a finding about my setup, which is what this file is for.
    let credOk = false;
    try {
      const tu = "https://opentask.ai/api/agent/auth/token";
      const rt = await fetch(tu, { method: "POST", headers: { "Content-Type": "application/json", DPoP: await proof("POST", tu) },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: cred.refresh_token }) });
      if (rt.ok) { cred.access_token = (await rt.json()).access_token; credOk = true; ok("opentask credential valid"); }
      else {
        const body = await rt.text();
        const revoked = /reuse|invalid_grant|revoked|not available/i.test(body);
        bad(revoked ? "opentask credential REVOKED — unrecoverable without re-registering" : "opentask credential rejected",
          `${rt.status} ${body.slice(0, 120)}`);
      }
    } catch (e) { bad("opentask token endpoint unreachable", String(e.message).slice(0, 60)); }
    // Without a valid credential the checks below cannot run, and saying so once is clearer than
    // two SKIPs that imply a transient problem.
    if (!credOk) {
      console.log("      ↳ readiness and payout checks cannot run; the entry itself is verified below");
    }
    const authed = async (url) => {
      try {
        const r = await fetch(url, { headers: { Accept: "application/json",
          Authorization: `DPoP ${cred.access_token}`, DPoP: await proof("GET", url, cred.access_token) },
          signal: AbortSignal.timeout(25_000) });
        if (!r.ok) return { status: r.status };
        return { status: r.status, json: await r.json() };
      } catch (e) { return { error: String(e.message).slice(0, 60) }; }
    };
    const d = credOk ? await authed("https://opentask.ai/api/agent/me/discovery-readiness") : { status: "no valid credential" };
    // The hint here used to be hardcoded to "needs a fresh DPoP proof" — a guess about the cause,
    // printed as though it were the diagnosis, and wrong for eight days while the real cause was a
    // revoked grant. Only offer that explanation when the credential is known good.
    if (!d.json) skip("opentask readiness", `status ${d.status ?? d.error}${credOk ? " (needs a fresh DPoP proof)" : " — see the FAIL above"}`);
    else {
      const r = d.json.readiness ?? {};
      r.status === "ready" ? ok("opentask discovery readiness", `score ${r.score}`)
                           : bad(`opentask readiness is "${r.status}"`, `score ${r.score}`);
      for (const s of r.sections ?? [])
        for (const a of s.actions ?? []) if (a.severity === "critical") bad("opentask CRITICAL", `${s.label}: ${a.label.slice(0, 70)}`);
    }
    const p = credOk ? await authed("https://opentask.ai/api/agent/me/payout-methods") : { status: "no valid credential" };
    if (!p.json) skip("opentask payout methods", `status ${p.status ?? p.error}`);
    else (p.json.activePayoutMethodCount > 0)
      ? ok("opentask payout method configured", `${p.json.activePayoutMethodCount} active`)
      : bad("opentask has NO payout method", "cannot be paid even if work is awarded");
  }
}

console.log("\n=== live contest entry ===");
{
  const TASK = process.env.ARCADE_TASK || "cmsulgbho008804jygehnzytv";
  const t = await getJSON(`https://opentask.ai/api/tasks/${TASK}`);
  const task = t.json?.task;
  if (!task) skip("contest task", `status ${t.status ?? t.error}`);
  else {
    const hrs = task.deadline ? (Date.parse(task.deadline) - Date.now()) / 3.6e6 : null;
    ok("contest task reachable", `${task.executionPhase}, ${hrs ? hrs.toFixed(0) + "h to deadline" : "no deadline"}`);
    if (hrs !== null && hrs < 0 && task.executionPhase === "accepting_entries")
      soft("contest deadline passed but still accepting entries", "phase may be stale");
  }
  // The artifact a judge would actually fetch, and whether it still hashes to what was declared.
  const url = process.env.ENTRY_URL || "https://asherkasper.github.io/opentask-arcade-entry/opentask-v3.mp4";
  const want = process.env.ENTRY_SHA256 || "22760666674c3b4436967dd89a397039c451d58f93d60434a93e4eac18a1f821";
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) bad("entry artifact does not resolve", `status ${r.status}`);
    else {
      const buf = Buffer.from(await r.arrayBuffer());
      const { createHash } = await import("node:crypto");
      const got = createHash("sha256").update(buf).digest("hex");
      got === want ? ok("entry artifact hash matches what was submitted", `${buf.length} bytes`)
                   : bad("entry artifact HASH MISMATCH", "the judge is fetching a different file than was declared");
      const ct = r.headers.get("content-type") || "";
      ct.startsWith("video/") ? ok("entry serves as video", ct)
                              : soft("entry does not serve as video/*", `${ct} — a browser may download rather than play it`);
    }
  } catch (e) { skip("entry artifact", String(e.message).slice(0, 50)); }
}

console.log("\n=== on-chain, where money would actually land ===");
{
  const ADDR = process.env.PAYOUT_ADDR || "0xe9d3ce3E1A8695c87314A1C6b25130Cc266B1477";
  const CHAINS = [
    ["Base", "https://mainnet.base.org", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
    ["Arbitrum", "https://arb1.arbitrum.io/rpc", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"],
    ["Optimism", "https://mainnet.optimism.io", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"],
  ];
  for (const [name, rpc, usdc] of CHAINS) {
    try {
      const data = "0x70a08231" + ADDR.slice(2).toLowerCase().padStart(64, "0");
      const r = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: usdc, data }, "latest"] }),
        signal: AbortSignal.timeout(25_000) });
      const j = await r.json();
      // An RPC error is NOT a zero balance. Reporting it as one would hide the first payment.
      if (j.error || !j.result || j.result === "0x") { skip(`${name} balance`, "RPC unreadable — not counted as zero"); continue; }
      const usd = Number(BigInt(j.result)) / 1e6;
      usd > 0 ? console.log(`****  ${name}: ${usd} USDC RECEIVED — check the ledger`) : ok(`${name} balance read`, `${usd} USDC`);
    } catch { skip(`${name} balance`, "unreachable — not counted as zero"); }
  }
}

console.log(`\n${fail} failure(s), ${warn} warning(s), ${skipped} skipped.`);
if (skipped) console.log("A SKIP is not a pass. Anything skipped above was not actually checked.");
process.exitCode = fail ? 1 : 0;
