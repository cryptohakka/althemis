// browser-src/crypto-shim.ts
// Node の `crypto` モジュールのうち、@circle-fin/x402-batching/client が
// 使う `randomBytes(n).toString("hex")` だけをブラウザの
// crypto.getRandomValues で再現する最小シム。
// esbuild の alias 設定で "crypto" インポートをこのファイルに差し替える。

class BytesWithHex extends Uint8Array {
  toString(encoding?: string): string {
    if (encoding === "hex") {
      return Array.from(this)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
    return super.toString();
  }
}

export function randomBytes(size: number): BytesWithHex {
  const bytes = new BytesWithHex(size);
  if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.getRandomValues) {
    throw new Error("crypto.getRandomValues unavailable in this browser context");
  }
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export default { randomBytes };
