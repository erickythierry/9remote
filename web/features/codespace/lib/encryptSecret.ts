// Encrypt a secret using libsodium sealed box (compatible with GitHub secrets API)
import sodium from "libsodium-wrappers";

let ready: Promise<void> | null = null;

async function ensureReady(): Promise<void> {
  if (!ready) ready = sodium.ready;
  await ready;
}

// Encrypt plaintext with a base64 public key, returns base64 ciphertext
export async function encryptForGithub(publicKeyBase64: string, plaintext: string): Promise<string> {
  await ensureReady();
  const publicKey = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  const message = sodium.from_string(plaintext);
  const cipher = sodium.crypto_box_seal(message, publicKey);
  return sodium.to_base64(cipher, sodium.base64_variants.ORIGINAL);
}

// Generate a random URL-safe API key
export function generateApiKey(bytes = 24): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}
