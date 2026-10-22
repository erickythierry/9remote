import CryptoJS from "crypto-js";

/**
 * Decrypt token and validate expiry. Secret from env.TOKEN_SECRET or env.APP_SECRET.
 */
export function decryptToken(token: string, env?: { TOKEN_SECRET?: string; APP_SECRET?: string } | null): { key: string; exp: number } | null {
  const secret = env?.TOKEN_SECRET || env?.APP_SECRET;
  if (!secret) throw new Error("TOKEN_SECRET or APP_SECRET not configured");
  try {
    const decrypted = CryptoJS.AES.decrypt(
      decodeURIComponent(token),
      secret
    ).toString(CryptoJS.enc.Utf8);
    const payload = JSON.parse(decrypted);
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
