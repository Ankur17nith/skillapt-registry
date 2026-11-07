/**
 * Computes the hexadecimal SHA-256 hash of a buffer or Uint8Array.
 * Uses standard Web Crypto API (supported in Cloudflare Workers and Node 18+).
 */
export async function computeSha256(data: ArrayBuffer | Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Validates that an incoming buffer matches an expected SHA-256 hash.
 */
export async function verifySha256(data: ArrayBuffer | Uint8Array, expectedHex: string): Promise<boolean> {
  const actual = await computeSha256(data);
  return actual.toLowerCase() === expectedHex.toLowerCase();
}
