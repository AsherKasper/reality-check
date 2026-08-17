#!/usr/bin/env node
// em-client — the execution.market HTTP helper that funded-sweep.mjs imports.
//
// Why this file exists at all: funded-sweep.mjs has imported `./em-client.mjs` since its
// first commit, and this module was never committed. It lived in a scratch directory on the
// machine that produced the numbers, so the sweep ran fine *for me* and crashed on line 5
// for everyone else — `ERR_MODULE_NOT_FOUND`, before a single request.
//
// It was published in that state. A tool whose whole argument is "measure it, don't assume
// it" shipped as something the reader could not run and therefore had to take on trust.
// That is the exact failure it was written to attack. Fixed 2026-08-17.
//
// AUTH: every endpoint the sweep touches is public and needs no credential. The upstream API
// uses ERC-8128 signed HTTP for the write side (applying to a task, delivering work). Signing
// is deliberately NOT implemented here — it needs a private key, and a key does not belong in
// a repo or in the import path of a read-only measurement tool. If you need the write side,
// wrap this module; do not add a key to it.
//
// Written by an autonomous AI agent (Claude Code). MIT.

import { pathToFileURL } from "node:url";

const BASE = process.env.EM_BASE || "https://api.execution.market";
const UA = { Accept: "application/json", "User-Agent": "agent-market-data" };

/**
 * call(method, path) -> { json } | { error }
 *
 * Never throws and never rejects: the sweep walks thousands of offsets, and one dropped
 * keep-alive on offset 1700 must not lose the other 1699. Callers read `.json` and treat a
 * missing one as "no rows", so an error has to arrive as a value.
 *
 * Retries 429 and 5xx with a linear backoff. Does NOT retry 4xx — a 404 is an answer.
 */
export async function call(method, path, body, tries = 3) {
  const url = path.startsWith("http") ? path : BASE + path;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        method,
        headers: body ? { ...UA, "Content-Type": "application/json" } : UA,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(40_000),
      });
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      if (!r.ok) return { error: "HTTP " + r.status, status: r.status };
      const text = await r.text();
      // A login wall or an edge error page returns 200 with HTML. Parsing that as JSON throws
      // inside the try and would be retried as if it were a network fault; name it instead.
      if (text.trimStart().startsWith("<")) return { error: "html-not-json", status: r.status };
      return { json: JSON.parse(text), status: r.status };
    } catch (e) {
      if (i === tries - 1) return { error: String(e.message).slice(0, 80) };
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
  }
}

// Run directly for a one-line reachability check before trusting a sweep's output:
//   node em-client.mjs
// (Use pathToFileURL, not string-building: on Windows a path is `C:\...`, and `file://` + that
// yields `file://C:/...` while import.meta.url is `file:///C:/...` — three slashes. The first
// version of this line compared those two and silently never ran. A self-test that cannot
// fire is indistinguishable from one that passes, which is the bug this file was written over.)
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = await call("GET", "/api/v1/public/metrics");
  console.log(r.error ? `unreachable: ${r.error}` : `reachable: ${JSON.stringify(r.json?.tasks ?? r.json).slice(0, 160)}`);
}
