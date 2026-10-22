import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { API_ENDPOINTS, TUNNEL_VERIFY_RETRY_MAX, TUNNEL_VERIFY_RETRY_INTERVAL_MS, TUNNEL_VERIFY_TIMEOUT_MS, CONNECT_TIMEOUT_MS, LOCAL_HOST_STATE, IS_SELF_HOSTED } from "@/shared/constants/API";
import { headOf, tailOf } from "@/shared/utils/apiKey";
import { setTrust } from "@/shared/transport/lib/deviceTrust";
import { isLocalHostNetwork, isLoopbackOrigin, hostOriginFrom } from "@/shared/utils/localOrigin";

// Marker string localized by the login page.
const WRONG_KEY_MESSAGE = "wrong-key-tail";
import { useSessionStorage } from "./useSessionStorage";

export async function verifyServerConnection(tunnelUrl: string, apiKey: string, timeout = TUNNEL_VERIFY_TIMEOUT_MS): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(`${tunnelUrl}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// Pre-verify TAIL with host over tunnel; returns null if unreachable.
export async function verifyKeyWithHost(tunnelUrl: string, { tail, tempKey }: { tail?: string | null; tempKey?: string | null }, timeout = TUNNEL_VERIFY_TIMEOUT_MS): Promise<boolean | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(`${tunnelUrl}/api/verify-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tail: tail || null, tempKey: tempKey || null }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json())?.ok === true;
  } catch {
    return null;
  }
}
export const verifyKeyWithAgent = verifyKeyWithHost;

// Resolve origin where host answers, or null if remote.
async function resolveHostOrigin(): Promise<string | null> {
  // Self-hosted VPN client: this shortcut reads the host state over loopback, which is the phone itself.
  // The regular /api/connect path below reaches the host at this origin instead, host keys included.
  if (IS_SELF_HOSTED && !isLoopbackOrigin()) return null;
  if (!isLoopbackOrigin()) return isLocalHostNetwork() ? window.location.origin : null;
  return hostOriginFrom(await fetchHostState());
}

async function fetchHostState(): Promise<{ permanentKey?: string; oneTimeKey?: string } | null> {
  try {
    const res = await fetch(LOCAL_HOST_STATE);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

interface AuthCredentials {
  apiKey?: string | null;
  token?: string | null;
  tempKey?: string | null;
  tail?: string | null;
  [key: string]: unknown;
}

interface AuthOptions {
  persistSession?: boolean;
}

interface ConnectResponse {
  apiKey: string;
  tunnelUrl?: string | null;
  localIp?: string | null;
  hostKeys?: { x?: string; ed?: string | null };
}

export type AuthResult =
  | { success: true; shouldAskToSave: true; apiKey: string | null }
  | { success: false; wrongTail: true }
  | { success: false; error: string };

export function useAuth() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const { setAuth } = useSessionStorage();

  const authenticate = useCallback(async (credentials: AuthCredentials, { persistSession = true }: AuthOptions = {}): Promise<AuthResult> => {
    setLoading(true);
    setError("");

    try {
      const hostOrigin = await resolveHostOrigin();

      if (hostOrigin) {
        const tail = credentials.tail || tailOf(credentials.apiKey || "");
        const tempKey = credentials.tempKey || ((credentials.token?.length ?? Infinity) <= 8 ? credentials.token : null);
        // A local host can only speak for ITS OWN credentials: another machine's
        // key or pairing code must not be judged by this host, or every remote
        // one fails as "wrong tail" before the server is ever asked.
        const state = await fetchHostState();
        const localHead = headOf(state?.permanentKey || "");
        const keyHead = headOf(credentials.apiKey || credentials.token || "");
        // A pairing code belongs to this host only when its live code IS that code.
        const localCode = String(state?.oneTimeKey || "").slice(0, 6).toUpperCase();
        const speaksForThisKey = tempKey
          ? !!localCode && localCode === tempKey.toUpperCase()
          : (!!localHead && !!keyHead && headOf(localHead) === keyHead);
        try {
          const directCheck = speaksForThisKey ? await verifyKeyWithHost(hostOrigin, { tail, tempKey }) : null;
          if (directCheck === true) {
            const rawKey = credentials.apiKey || tempKey || "";
            const apiKey = headOf(rawKey) || "direct";
            if (tail) setTrust(apiKey, { tail });
            if (persistSession) {
              setAuth({
                apiKey,
                tunnelUrl: hostOrigin,
                mode: "local",
                tempKey: tempKey ? tempKey.toUpperCase() : null,
                localIp: null
              });
            }
            return { success: true, shouldAskToSave: true, apiKey };
          } else if (directCheck === false) {
            setError(WRONG_KEY_MESSAGE);
            return { success: false, wrongTail: true };
          }
        } catch {
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(API_ENDPOINTS.connect, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...credentials, apiKey: headOf(credentials.apiKey) }),
          signal: controller.signal
        });
      } catch (e) {
        throw new Error((e as { name?: string } | null)?.name === "AbortError" ? "Connection timed out. Please try again." : "Network error. Please try again.");
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Authentication failed");
      }

      const data = await response.json() as ConnectResponse;

      const apiKey = headOf(credentials.apiKey || data.apiKey);

      // Store host public/seal keys from session for E2E encryption.
      if (data.hostKeys?.x) {
        setTrust(apiKey as string, { hostSealKey: data.hostKeys.x, hostPubKey: data.hostKeys.ed || null });
      }

      // Best-effort TAIL pre-verification directly against host.
      const tail = credentials.tail || tailOf(credentials.apiKey || "");
      if (data.tunnelUrl && (tail || credentials.tempKey)) {
        const verdict = await verifyKeyWithHost(data.tunnelUrl, {
          tail,
          tempKey: credentials.tempKey || null
        });
        if (verdict === false) {
          setError(WRONG_KEY_MESSAGE);
          return { success: false, wrongTail: true };
        }
      }

      if (persistSession) {
        setAuth({
          apiKey,
          tunnelUrl: data.tunnelUrl || null,
          mode: "remote",
          tempKey: credentials.tempKey ? credentials.tempKey.toUpperCase() : null,
          localIp: data.localIp || null
        });
      }

      return {
        success: true,
        shouldAskToSave: true,
        apiKey
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Authentication failed";
      setError(message);
      return { success: false, error: message };
    } finally {
      setLoading(false);
    }
  }, [router, setAuth]);

  const authenticateWithToken = useCallback(async (token: string, isTempKey = false, tail: string | null = null, opts?: AuthOptions): Promise<AuthResult> => {
    if (isTempKey) {
      return authenticate({ token, tempKey: token, tail }, opts);
    }
    return authenticate({ token }, opts);
  }, [authenticate]);

  const authenticateWithApiKey = useCallback((apiKey: string, opts?: AuthOptions): Promise<AuthResult> => {
    return authenticate({ apiKey }, opts);
  }, [authenticate]);

  return {
    loading,
    error,
    setError,
    authenticateWithToken,
    authenticateWithApiKey
  };
}
