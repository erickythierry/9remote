// Anonymous IAP API client. Works on web (same-origin /api) and inside WebView.
// Account is created lazily and cached in storage.

const ACCT_KEY = "iap_account_id";
const DEV_KEY = "iap_device_id";

interface KeyValueStore {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<unknown> | unknown;
}

interface ApiEnvelope<T> {
  data?: T;
  error?: string;
}

export interface Entitlement {
  [key: string]: unknown;
}

export interface VerifyResult {
  verified: boolean;
  error?: string;
  expiresAt?: string | null;
  originalPurchaseDate?: string | null;
}

async function getStore(): Promise<KeyValueStore> {
  if (typeof localStorage !== "undefined") return localStorage;
  // Hide specifier from web bundler; only resolved in RN runtime
  const mod = "@react-native-async-storage/async-storage";
  const AsyncStorage = (await import(/* webpackIgnore: true */ mod)).default;
  return {
    getItem: (k: string) => AsyncStorage.getItem(k),
    setItem: (k: string, v: string) => AsyncStorage.setItem(k, v)
  };
}

async function getDeviceId(): Promise<string> {
  const store = await getStore();
  let id = await store.getItem(DEV_KEY);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `dev_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await store.setItem(DEV_KEY, id);
  }
  return id;
}

export async function getAccountId(platform: string, providerAccount: string | null = null): Promise<string> {
  const store = await getStore();
  let accountId = await store.getItem(ACCT_KEY);
  if (accountId) return accountId;
  const deviceId = await getDeviceId();
  const base = apiBase();
  const res = await fetch(`${base}/api/iap/account`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, platform, providerAccount })
  });
  if (!res.ok) throw new Error(`account failed: ${res.status}`);
  const data = (await res.json()) as ApiEnvelope<{ accountId: string }>;
  accountId = data.data!.accountId;
  await store.setItem(ACCT_KEY, accountId);
  return accountId;
}

export async function getEntitlement(accountId: string): Promise<Entitlement | undefined> {
  const res = await fetch(`${apiBase()}/api/iap/entitlement?accountId=${encodeURIComponent(accountId)}`);
  if (!res.ok) throw new Error(`entitlement failed: ${res.status}`);
  const data = (await res.json()) as ApiEnvelope<Entitlement>;
  return data.data;
}

export async function verifyPurchase({ accountId, platform, productId, transactionId, receipt, purchaseToken }: {
  accountId: string;
  platform: string;
  productId: string;
  transactionId?: string;
  receipt?: string;
  purchaseToken?: string;
}): Promise<VerifyResult> {
  const res = await fetch(`${apiBase()}/api/iap/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, platform, productId, transactionId, receipt, purchaseToken })
  });
  const data = (await res.json()) as ApiEnvelope<VerifyResult>;
  if (!res.ok || !data.data?.verified) throw new Error(data.error || data.data?.error || "verify failed");
  return data.data;
}

function apiBase(): string {
  // Inside WebView, use same-origin (web domain). Native shell calls absolute URL via injected config.
  const w = typeof window !== "undefined" ? (window as Window & { MOBILE_APP?: unknown; API_BASE?: string }) : undefined;
  if (w && w.location && w.location.origin && !w.MOBILE_APP) {
    return w.location.origin;
  }
  return w && w.API_BASE ? w.API_BASE : "";
}
