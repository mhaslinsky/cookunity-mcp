import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CookUnityAuth } from "./auth.js";
import { finish, start } from "../login.js";

function tokenFile(context: { after: (fn: () => void) => void }, token?: string): string {
  const directory = mkdtempSync(join(tmpdir(), "cookunity-mcp-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "token.json");
  if (token) writeFileSync(path, JSON.stringify({ refresh_token: token }));
  return path;
}

test("refresh saves the rotated token, owner-only, before the access token is used", async (context) => {
  const path = tokenFile(context, "old");
  const sent: Record<string, unknown>[] = [];
  const auth = new CookUnityAuth({ kind: "refresh", tokenFile: path }, async (_url, body) => (sent.push(body), { access_token: "access", refresh_token: "new", expires_in: 86400 }));
  assert.equal(await auth.getAccessToken(), "access");
  assert.equal(await auth.getAccessToken(), "access");
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0]!.grant_type, sent[0]!.refresh_token], ["refresh_token", "old"]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { refresh_token: "new" });
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("a failed refresh points at the login command and keeps the old token", async (context) => {
  const path = tokenFile(context, "old");
  const auth = new CookUnityAuth({ kind: "refresh", tokenFile: path }, async () => { throw new Error("invalid_grant"); });
  await assert.rejects(auth.getAccessToken(), /refresh failed \(invalid_grant\)\. Run cookunity-mcp-login again/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { refresh_token: "old" });
});

test("login finish trades the code with the saved verifier and refuses another sign-in's state", async (context) => {
  const path = tokenFile(context);
  const { state, snippet } = start(path, 1000);
  assert.match(snippet, /prompt=none/);
  await assert.rejects(finish(path, "code", "other-state", async () => ({}), 2000), /state from the browser does not match/);
  const sent: Record<string, unknown>[] = [];
  await finish(path, "code", state, async (_url, body) => (sent.push(body), { refresh_token: "minted", expires_in: 86400 }), 2000);
  assert.equal(typeof sent[0]!.code_verifier, "string");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { refresh_token: "minted" });
});
