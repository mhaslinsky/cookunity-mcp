import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where the refresh token lives unless COOKUNITY_TOKEN_FILE says otherwise. */
export function defaultTokenFile(): string {
  return process.env.COOKUNITY_TOKEN_FILE ?? join(homedir(), ".config", "cookunity-mcp", "token.json");
}

/** Writes JSON readable only by the owner, replacing the file in one rename so a crash never leaves half a token. */
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(next, 0o600);
  renameSync(next, path);
}

export function readRefreshToken(path: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`No CookUnity sign-in at ${path}. Run cookunity-mcp-login to create one.`);
  }
  const token = (parsed as { refresh_token?: unknown } | null)?.refresh_token;
  if (typeof token !== "string" || token === "") {
    throw new Error(`The CookUnity sign-in at ${path} has no refresh token. Run cookunity-mcp-login again.`);
  }
  return token;
}
