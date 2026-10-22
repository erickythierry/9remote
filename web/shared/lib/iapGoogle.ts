// Google Play Developer API verify — service account via Web Crypto (no googleapis).
// Fetches access token with RFC7523 JWT (RS256), then calls purchases.subscriptions.get.

interface GoogleEnv {
  GOOGLE_SERVICE_ACCOUNT_JSON?: string | ServiceAccount;
  GOOGLE_PACKAGE_NAME?: string;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

interface GooglePurchaseData {
  paymentState?: number;
  purchaseState?: number;
  expiryTimeMillis?: string | number;
  startTimeMillis?: string | number;
}

export interface GoogleVerifyResult {
  verified: boolean;
  error?: string;
  expiresAt?: string | null;
  originalPurchaseDate?: string | null;
}

function b64urlDecode(str: string): Uint8Array<ArrayBuffer> {
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function pemToDerBytes(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "").replace(/\\n/g, "");
  return b64urlDecode(b64);
}

function parseServiceAccount(env: GoogleEnv): ServiceAccount {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON");
  const obj = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<ServiceAccount>;
  if (!obj.client_email || !obj.private_key) throw new Error("Invalid service account JSON");
  return obj as ServiceAccount;
}

async function getGoogleAccessToken(env: GoogleEnv): Promise<string> {
  const sa = parseServiceAccount(env);
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToDerBytes(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };
  const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const data = `${enc(header)}.${enc(payload)}`;
  const sig = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data)
  ));
  const sigB64 = btoa(String.fromCharCode(...sig)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const assertion = `${data}.${sigB64}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${assertion}`
  });
  if (!res.ok) throw new Error(`Google token: ${res.status}`);
  const tok = (await res.json()) as { access_token: string };
  return tok.access_token;
}

export async function verifyGooglePurchase(env: GoogleEnv, { purchaseToken, productId }: {
  purchaseToken?: string;
  productId?: string;
}): Promise<GoogleVerifyResult> {
  if (!purchaseToken) return { verified: false, error: "Missing purchaseToken" };
  const packageName = env.GOOGLE_PACKAGE_NAME;
  if (!packageName) return { verified: false, error: "Missing GOOGLE_PACKAGE_NAME" };

  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken(env);
  } catch (e) {
    return { verified: false, error: (e as Error).message };
  }

  // Try subscription first, then one-time product
  for (const kind of ["subscriptions", "products"] as const) {
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}/purchases/${kind}/${productId}/tokens/${purchaseToken}`;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (res.status === 404) continue;
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        return { verified: false, error: `Google API ${res.status}: ${err.error?.message || ""}` };
      }
      const data = (await res.json()) as GooglePurchaseData;
      // subs: 0=active/renewed, products: 0=purchased
      const ok = kind === "subscriptions"
        ? data.paymentState === 0 || data.paymentState === 1
        : data.purchaseState === 0;
      if (!ok) return { verified: false, error: `Invalid state: ${JSON.stringify({ paymentState: data.paymentState, purchaseState: data.purchaseState })}` };
      return {
        verified: true,
        expiresAt: data.expiryTimeMillis ? new Date(Number(data.expiryTimeMillis)).toISOString() : null,
        originalPurchaseDate: data.startTimeMillis ? new Date(Number(data.startTimeMillis)).toISOString() : null
      };
    } catch (e) {
      // try next kind
    }
  }
  return { verified: false, error: "Not found as sub or product" };
}
