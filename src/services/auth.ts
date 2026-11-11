import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { AuthTokens } from "../types.js";
import { AUTH_BASE_URL, AUTH_CLIENT_ID, AUTH_REALM } from "../constants.js";
import { readRefreshToken, writePrivateJson } from "./token-store.js";

const REDIRECT_URI = "https://www.cookunity.com";

/** A password account signs in with email and password; a Google-linked account uses a saved refresh token. */
export type Credentials =
  | { kind: "password"; email: string; password: string }
  | { kind: "refresh"; tokenFile: string };

export type PostJson = (url: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;

const postJson: PostJson = async (url, body) => {
  const response = await axios.post(url, body, { headers: { "Content-Type": "application/json" }, timeout: 30000 });
  return response.data as Record<string, unknown>;
};

export class CookUnityAuth {
  private credentials: Credentials;
  private post: PostJson;
  private tokens: AuthTokens | null = null;
  private signingIn: Promise<void> | null = null;

  constructor(credentials: Credentials, post: PostJson = postJson) {
    this.credentials = credentials;
    this.post = post;
  }

  async getAccessToken(): Promise<string> {
    if (this.tokens && this.isTokenValid(this.tokens)) {
      return this.tokens.access_token;
    }
    // Parallel tool calls share one sign-in: a rotated refresh token is single-use.
    this.signingIn ??= (this.credentials.kind === "refresh"
      ? this.refresh(this.credentials.tokenFile)
      : this.authenticate(this.credentials.email, this.credentials.password)
    ).finally(() => { this.signingIn = null; });
    await this.signingIn;
    return this.tokens!.access_token;
  }

  /**
   * Auth0 rotates the refresh token on every use and rejects the old one, so the new one is saved
   * before the access token is used: losing it would mean signing in again in the browser.
   */
  private async refresh(tokenFile: string): Promise<void> {
    const refreshToken = readRefreshToken(tokenFile);
    let data: Record<string, unknown>;
    try {
      data = await this.post(`${AUTH_BASE_URL}/oauth/token`, {
        grant_type: "refresh_token",
        client_id: AUTH_CLIENT_ID,
        refresh_token: refreshToken,
      });
    } catch (error) {
      // Only a rejected token needs the browser login; a network error or 5xx leaves the saved one valid.
      const rejected = axios.isAxiosError(error) && [400, 401, 403].includes(error.response?.status ?? 0);
      const next = rejected ? "Run cookunity-mcp-login again." : "The saved sign-in is kept; try again.";
      throw new Error(`CookUnity sign-in refresh failed (${this.getErrorMessage(error)}). ${next}`);
    }
    const rotated = data.refresh_token;
    if (typeof data.access_token !== "string" || typeof data.expires_in !== "number" || (rotated !== undefined && (typeof rotated !== "string" || rotated === ""))) {
      throw new Error("CookUnity sign-in refresh returned an incomplete reply. Run cookunity-mcp-login again.");
    }
    // A grant without rotation omits refresh_token, and the saved one stays valid.
    try {
      if (rotated !== undefined) writePrivateJson(tokenFile, { refresh_token: rotated });
    } catch (error) {
      throw new Error(`The new CookUnity refresh token could not be saved to ${tokenFile} (${(error as Error).message}). Run cookunity-mcp-login again.`);
    }
    this.tokens = {
      access_token: data.access_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
  }

  private isTokenValid(tokens: AuthTokens): boolean {
    return Date.now() < tokens.expires_at - 60000;
  }

  private async authenticate(email: string, password: string): Promise<void> {
    try {
      // Create a session with cookie jar (Auth0 requires cookies across requests)
      const jar = new CookieJar();
      const client = wrapper(axios.create({ jar, timeout: 30000 }));

      // Step 1: Get login ticket
      const r1 = await client.post(`${AUTH_BASE_URL}/co/authenticate`, {
        client_id: AUTH_CLIENT_ID,
        credential_type: "http://auth0.com/oauth/grant-type/password-realm",
        username: email,
        password,
        realm: AUTH_REALM,
      }, {
        headers: { "Content-Type": "application/json", "Origin": "https://www.cookunity.com" },
      });

      const loginTicket = r1.data?.login_ticket as string | undefined;
      if (!loginTicket) throw new Error("Failed to get login ticket");

      // Step 2: Authorize — follow redirects to get the auth code
      const params = new URLSearchParams({
        client_id: AUTH_CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        scope: "openid profile email",
        realm: AUTH_REALM,
        login_ticket: loginTicket,
      });

      // Follow redirects until we get a code in the callback URL
      let currentUrl = `${AUTH_BASE_URL}/authorize?${params}`;
      let code: string | null = null;
      for (let i = 0; i < 5; i++) {
        const r = await client.get(currentUrl, {
          maxRedirects: 0,
          validateStatus: (status) => status === 302,
        });
        const loc = r.headers.location as string | undefined;
        if (!loc) throw new Error("No redirect location in authorize flow");
        const resolved = loc.startsWith("http") ? loc : `${AUTH_BASE_URL}${loc}`;
        const parsed = new URL(resolved);
        code = parsed.searchParams.get("code");
        if (code) break;
        currentUrl = resolved;
      }
      if (!code) throw new Error("Failed to obtain authorization code");

      // Step 3: Exchange code for tokens
      const r4 = await client.post(`${AUTH_BASE_URL}/oauth/token`, {
        client_id: AUTH_CLIENT_ID,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }, {
        headers: { "Content-Type": "application/json" },
      });

      const tokenData = r4.data as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!tokenData.access_token) throw new Error("Failed to get access token");

      this.tokens = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: Date.now() + (tokenData.expires_in ?? 86400) * 1000,
      };
    } catch (error) {
      throw new Error(`Authentication failed: ${this.getErrorMessage(error)}`);
    }
  }

  private getErrorMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
      const data = error.response?.data as Record<string, unknown> | undefined;
      if (data?.error_description) return String(data.error_description);
      if (data?.message) return String(data.message);
      if (error.response?.status) return `HTTP ${error.response.status}: ${error.response.statusText}`;
    }
    return error instanceof Error ? error.message : "Unknown error";
  }
}
