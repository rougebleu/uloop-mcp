#!/usr/bin/env node
// Smoke test: speaks MCP (newline-delimited JSON-RPC) to server.mjs over stdio.
// Verifies: initialize -> tools/list -> tools/call (read-only calls only).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "server.mjs");
const projectDir = process.env.ULOOP_PROJECT_DIR || process.cwd();

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, ULOOP_PROJECT_DIR: projectDir },
});
const rl = createInterface({ input: child.stdout });
let seq = 0;
const pending = new Map();
rl.on("line", (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m && m.id !== undefined && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); }
});
function send(method, params) {
  const id = ++seq;
  const p = new Promise((resolve) => pending.set(id, { resolve }));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return p;
}
async function call(method, params, label, timeoutMs = 60000) {
  const timer = new Promise((_, rej) => setTimeout(() => rej(new Error(label + " timed out")), timeoutMs));
  try {
    const res = await Promise.race([send(method, params), timer]);
    return res;
  } catch (e) { console.error("FAIL:", label, "->", e.message); process.exitCode = 1; return null; }
}
function show(label, res, max = 1500) {
  if (!res) return;
  if (res.error) { console.log(label, "ERROR:", JSON.stringify(res.error)); process.exitCode = 1; return; }
  const text = JSON.stringify(res.result).slice(0, max);
  console.log(label, "OK:", text);
}

const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "uloop-mcp-smoke", version: "0.0.1" } }, "initialize");
show("initialize", init, 400);
if (!init || init.error) { child.kill(); process.exit(process.exitCode || 1); }
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const list = await call("tools/list", {}, "tools/list");
if (list && !list.error) {
  const names = list.result.tools.map((t) => t.name);
  console.log("tools/list OK: " + names.length + " tools -> " + names.join(", "));
} else { console.error("FAIL: tools/list"); process.exitCode = 1; }

const pm = await call("tools/call", { name: "unity_control_play_mode", arguments: { action: "Status" } }, "unity_control_play_mode Status");
show("tools/call unity_control_play_mode", pm, 600);

const hr = await call("tools/call", { name: "unity_hot_reload", arguments: { status: true } }, "unity_hot_reload status");
show("tools/call unity_hot_reload", hr, 900);

const logs = await call("tools/call", { name: "unity_get_logs", arguments: { max_count: 3 } }, "unity_get_logs");
show("tools/call unity_get_logs", logs, 900);

child.stdin.end();
await new Promise((r) => { child.on("exit", r); setTimeout(r, 5000).unref(); });
console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE PASSED");
process.exit(process.exitCode || 0);
