#!/usr/bin/env node
/**
 * Signs a Google-linked CookUnity account in without a password. CookUnity's web app keeps an
 * Auth0 session, so a silent /authorize request from its own page returns a code. `start` keeps
 * the PKCE verifier on disk and prints only the browser snippet, so the code a person or agent
 * copies back is useless to anyone without that file. `finish` trades it for a refresh token.
 */
import axios from "axios";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { AUTH_BASE_URL, AUTH_CLIENT_ID } from "./constants.js";
import { defaultTokenFile, writePrivateJson } from "./services/token-store.js";

const APP_ORIGIN = "https://subscription.cookunity.com";
const AUDIENCE = "https://cookunity.com";
const SCOPE = "openid profile email offline_access";
const PENDING_MAX_AGE_MS = 10 * 60 * 1000;

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** The snippet to run in the browser console on the CookUnity subscription page; it returns { code, state } or { error }. */
export function browserSnippet(challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: AUTH_CLIENT_ID, response_type: "code", response_mode: "web_message", prompt: "none",
    redirect_uri: APP_ORIGIN, scope: SCOPE, audience: AUDIENCE,
    code_challenge: challenge, code_challenge_method: "S256", state, nonce: state,
  });
  return `await (async () => {
  if (location.origin !== ${JSON.stringify(APP_ORIGIN)}) return { error: "open ${APP_ORIGIN} first" };
  return await new Promise(resolve => {
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    const done = value => { window.removeEventListener("message", onMessage); frame.remove(); resolve(value); };
    const onMessage = event => {
      if (event.origin !== ${JSON.stringify(AUTH_BASE_URL)} || event.data?.type !== "authorization_response") return;
      const response = event.data.response || {};
      done(response.code ? { code: response.code, state: response.state } : { error: response.error || "no code" });
    };
    window.addEventListener("message", onMessage);
    setTimeout(() => done({ error: "timed out; sign in to CookUnity in this browser and retry" }), 15000);
    frame.src = ${JSON.stringify(`${AUTH_BASE_URL}/authorize?`)} + ${JSON.stringify(params.toString())};
    document.body.appendChild(frame);
  });
})();`;
}

type Pending = { verifier: string; state: string; created_at: number };

export function start(tokenFile: string, now = Date.now()): { snippet: string; state: string } {
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  writePrivateJson(`${tokenFile}.pending`, { verifier, state, created_at: now } satisfies Pending);
  return { snippet: browserSnippet(challenge, state), state };
}

export type PostJson = (url: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
const postJson: PostJson = async (url, body) => (await axios.post(url, body, { headers: { "Content-Type": "application/json" }, timeout: 30000 })).data;

export async function finish(tokenFile: string, code: string, state: string, post: PostJson = postJson, now = Date.now()): Promise<{ saved: string; scope: unknown; access_token_expires_in: unknown; response_fields: string[] }> {
  let pending: Pending;
  try {
    pending = JSON.parse(readFileSync(`${tokenFile}.pending`, "utf8")) as Pending;
  } catch {
    throw new Error("No sign-in in progress. Run cookunity-mcp-login start first.");
  }
  if (pending.state !== state) throw new Error("The state from the browser does not match this sign-in. Run start again.");
  if (now - pending.created_at > PENDING_MAX_AGE_MS) throw new Error("This sign-in is over 10 minutes old. Run start again.");
  const data = await post(`${AUTH_BASE_URL}/oauth/token`, {
    grant_type: "authorization_code", client_id: AUTH_CLIENT_ID, code, code_verifier: pending.verifier, redirect_uri: APP_ORIGIN,
  });
  if (typeof data.refresh_token !== "string" || data.refresh_token === "") {
    throw new Error("CookUnity returned no refresh token; the sign-in was not saved.");
  }
  writePrivateJson(tokenFile, { refresh_token: data.refresh_token });
  rmSync(`${tokenFile}.pending`, { force: true });
  return { saved: tokenFile, scope: data.scope, access_token_expires_in: data.expires_in, response_fields: Object.keys(data).sort() };
}

async function main(argv: string[]): Promise<number> {
  const tokenFile = defaultTokenFile();
  const [command, ...rest] = argv;
  const flag = (name: string) => { const index = rest.indexOf(name); return index >= 0 ? rest[index + 1] : undefined; };
  if (command === "start") {
    const { snippet, state } = start(tokenFile);
    console.log(`Open ${APP_ORIGIN} while signed in, run this in its console, then:\n  cookunity-mcp-login finish --code <code> --state ${state}\n\n${snippet}`);
    return 0;
  }
  const code = flag("--code");
  const state = flag("--state");
  if (command === "finish" && code && state) {
    console.log(JSON.stringify(await finish(tokenFile, code, state)));
    return 0;
  }
  console.error("usage: cookunity-mcp-login start | cookunity-mcp-login finish --code <code> --state <state>");
  return 64;
}

// npm links bins through symlinks, so compare the real path of what node was asked to run.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      const message = axios.isAxiosError(error) ? `HTTP ${error.response?.status ?? "error"}: ${JSON.stringify(error.response?.data ?? error.message)}` : (error as Error).message;
      console.error(`cookunity-mcp-login: ${message}`);
      process.exitCode = 1;
    },
  );
}
