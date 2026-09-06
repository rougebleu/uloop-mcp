#!/usr/bin/env node
// uloop-bridge - localhost HTTP bridge that runs the native uloop CLI (Unity CLI Loop v3).
// Run this OUTSIDE the DSH sandbox (normal terminal / startup script) so the named-pipe
// connection to Unity is allowed. Sandboxed agents then call it over loopback HTTP (TCP is
// permitted inside the DSH sandbox). Zero dependencies.
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.ULOOP_BRIDGE_PORT || 8787);
const HOST = "127.0.0.1";
const PROJECT_DIR = process.env.ULOOP_PROJECT_DIR || process.cwd();
const TIMEOUT_MS = Number(process.env.ULOOP_TIMEOUT_MS || 240000);
const TOKEN = process.env.ULOOP_BRIDGE_TOKEN || "";
const MAX_BODY = 2 * 1024 * 1024;

function cliTarget() {
  const local = process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir();
  const nativePath = path.join(local, "Programs", "uloop", "bin", "uloop.exe");
  for (const c of [{ path: process.env.ULOOP_CLI }, { path: nativePath }]) {
    if (c.path && existsSync(c.path)) return { path: c.path, isNode: /\.[cm]?js$/i.test(c.path) };
  }
  return { path: process.env.ULOOP || "uloop", isNode: false };
}

function runUloop(argv, projectDir) {
  return new Promise((resolve) => {
    const target = cliTarget();
    let child;
    try {
      const opts = { cwd: projectDir || PROJECT_DIR, windowsHide: true, env: process.env };
      child = target.isNode
        ? spawn(process.execPath, [target.path, ...argv], opts)
        : spawn(target.path, argv, { ...opts, shell: false });
    } catch (err) {
      return resolve({ ok: false, exitCode: -1, stdout: "", stderr: String((err && err.message) || err) });
    }
    let out = ""; let errOut = ""; let done = false;
    const t0 = Date.now();
    const timer = setTimeout(() => {
      if (!done) { done = true; try { child.kill(); } catch { /* ignore */ }
        resolve({ ok: false, exitCode: -2, stdout: out, stderr: errOut + "\n[uloop-bridge] timed out after " + TIMEOUT_MS + "ms", durationMs: Date.now() - t0 }); }
    }, TIMEOUT_MS);
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { errOut += c; });
    child.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, exitCode: -1, stdout: out, stderr: String(e.message || e), durationMs: Date.now() - t0 }); } });
    child.on("close", (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: code === 0, exitCode: code, stdout: out, stderr: errOut, durationMs: Date.now() - t0 }); } });
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://" + HOST);
  if (TOKEN && req.headers["x-uloop-token"] !== TOKEN) {
    return send(res, 401, { ok: false, error: "unauthorized" });
  }
  if (req.method === "GET" && u.pathname === "/health") {
    const target = cliTarget();
    return send(res, 200, { ok: true, pid: process.pid, cli: target.path, projectDir: PROJECT_DIR, port: PORT });
  }
  if (req.method === "POST" && u.pathname === "/run") {
    let raw = "";
    let tooBig = false;
    req.on("data", (c) => { raw += c; if (raw.length > MAX_BODY) tooBig = true; });
    req.on("end", async () => {
      if (tooBig) return send(res, 413, { ok: false, error: "body too large" });
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { ok: false, error: "invalid JSON" }); }
      let argv = Array.isArray(body.argv) ? body.argv.map(String) : null;
      if (!argv && typeof body.command === "string") argv = [body.command, ...(Array.isArray(body.args) ? body.args.map(String) : [])];
      if (!argv || !argv.length) return send(res, 400, { ok: false, error: "argv[] (or command) required" });
      const projectDir = typeof body.projectDir === "string" && body.projectDir ? body.projectDir : PROJECT_DIR;
      const result = await runUloop(argv, projectDir);
      return send(res, 200, { ok: result.ok, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs });
    });
    return;
  }
  return send(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, HOST, () => {
  const target = cliTarget();
  console.log("[uloop-bridge] listening on http://" + HOST + ":" + PORT + " | projectDir=" + PROJECT_DIR + " | cli=" + target.path);
});
