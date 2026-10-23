/** Build-time configuration. NEXT_PUBLIC_* values are inlined by Next.js. */
export const NODE_URL = (process.env.NEXT_PUBLIC_NODE_URL || "http://localhost:8787").replace(/\/+$/, "");
export const MOCK_MODE = process.env.NEXT_PUBLIC_MOCK === "1";

export function isLocalNode(url = NODE_URL): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** Prefilled on the sign-in screen only for a local node, never for a remote one. */
export const LOCAL_DEFAULT_TOKEN = "dev-admin-token";

const TOKEN_KEY = "payminto.clearing.adminToken";

export function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the session then lasts for this tab only.
  }
}
