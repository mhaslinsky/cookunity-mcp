import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AxiosError } from "axios";
import { CookUnityAuth } from "./auth.js";
import { finish, start } from "../login.js";

function tokenFile(context: { after: (fn: () => void) => void }, token?: string): string {
  const directory = mkdtempSync(join(tmpdir(), "cookunity-mcp-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "token.json");
  if (token) writeFileSync(path, JSON.stringify({ refresh_token: token }));
  return path;
}

test("parallel calls share one refresh, and the rotated token is saved owner-only", async (context) => {
  const path = tokenFile(context, "old");
  const sent: Record<string, unknown>[] = [];
  const auth = new CookUnityAuth({ kind: "refresh", tokenFile: path }, async (_url, body) => (sent.push(body), { access_token: "access", refresh_token: "new", expires_in: 86400 }));
  assert.deepEqual(await Promise.all([auth.getAccessToken(), auth.getAccessToken()]), ["access", "access"]);
  assert.equal(await auth.getAccessToken(), "access");
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0]!.grant_type, sent[0]!.refresh_token], ["refresh_token", "old"]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { refresh_token: "new" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("a failed refresh or an unsaved rotated token points at the login command", async (context) => {
  const path = tokenFile(context, "old");
  const rejected = new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, { status: 403, statusText: "Forbidden", data: { error_description: "Unknown or invalid refresh token." }, headers: {}, config: {} as never });
  const auth = new CookUnityAuth({ kind: "refresh", tokenFile: path }, async () => { throw rejected; });
  await assert.rejects(auth.getAccessToken(), /refresh failed \(Unknown or invalid refresh token\.\)\. Run cookunity-mcp-login again/);
  const offline = new CookUnityAuth({ kind: "refresh", tokenFile: path }, async () => { throw new AxiosError("timeout", "ECONNABORTED"); });
  await assert.rejects(offline.getAccessToken(), /refresh failed \(timeout\)\. The saved sign-in is kept; try again/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { refresh_token: "old" });
  const unsaved = new CookUnityAuth({ kind: "refresh", tokenFile: path }, async () => ({ access_token: "access", refresh_token: "new", expires_in: 86400 }));
  chmodSync(join(path, ".."), 0o500);
  try {
    await assert.rejects(unsaved.getAccessToken(), /could not be saved .* Run cookunity-mcp-login again/);
  } finally {
    chmodSync(join(path, ".."), 0o700);
  }
});

test("login finish trades the code with the saved verifier and refuses another sign-in's state", async (context) => {
  const path = tokenFile(context);
  const { state, snippet } = start(path, 1000);
  assert.match(snippet, /prompt=none/);
  await assert.rejects(finish(path, "code", "other-state", async () => ({}), 2000), /state from the browser does not match/);
  const sent: Record<string, unknown>[] = [];
  await finish(path, "code", state, async (_url, body) => (sent.push(body), { refresh_token: "minted", expires_in: 86400 }), 2000);
  const challenge = /code_challenge=([^&"]+)/.exec(snippet)![1];
  assert.equal(createHash("sha256").update(String(sent[0]!.code_verifier)).digest("base64url"), challenge);
  assert.equal(sent[0]!.code, "code");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { refresh_token: "minted" });
});
