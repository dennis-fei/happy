/**
 * crypto.subtle 只在安全上下文（HTTPS / localhost）里可用。
 * 手机通过 Tailscale / 局域网以 http://<ip>:8081 访问时，浏览器会禁用
 * crypto.subtle，导致 expo-crypto 的 digest（hmac_sha512 → deriveKey）
 * 在初始化阶段直接抛错、应用白屏。
 *
 * 运行时的端到端加密走 libsodium（tweetnacl），并不依赖 subtle；
 * 这里只用 @noble/hashes 补齐 subtle.digest，让 http 访问也能初始化。
 */

(function installWebCryptoPolyfills() {
    if (typeof globalThis === 'undefined') return;
    const cryptoObj: any = (globalThis as any).crypto;
    // 原生端没有 globalThis.crypto，不需要补
    if (!cryptoObj) return;

    // crypto.randomUUID 也只在安全上下文可用；getRandomValues 不受限，用它拼 UUIDv4
    if (typeof cryptoObj.randomUUID !== 'function' && typeof cryptoObj.getRandomValues === 'function') {
        const randomUUID = () => {
            const b = new Uint8Array(16);
            cryptoObj.getRandomValues(b);
            b[6] = (b[6] & 0x0f) | 0x40; // version 4
            b[8] = (b[8] & 0x3f) | 0x80; // variant 10
            const h: string[] = Array.from(b, (x: number) => x.toString(16).padStart(2, '0'));
            return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
        };
        try {
            Object.defineProperty(cryptoObj, 'randomUUID', { value: randomUUID, configurable: true });
        } catch {
            cryptoObj.randomUUID = randomUUID;
        }
    }

    // 安全上下文里 subtle 本来就有，不需要补
    if (cryptoObj.subtle) return;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { sha256, sha384, sha512 } = require('@noble/hashes/sha2');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { sha1 } = require('@noble/hashes/sha1');

    const algos: Record<string, (data: Uint8Array) => Uint8Array> = {
        'SHA-1': sha1,
        'SHA-256': sha256,
        'SHA-384': sha384,
        'SHA-512': sha512,
    };

    const subtle = {
        async digest(algorithm: unknown, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer> {
            const name = typeof algorithm === 'string' ? algorithm : (algorithm as any)?.name;
            const fn = algos[String(name).toUpperCase()];
            if (!fn) {
                throw new Error(`webCrypto polyfill: unsupported digest algorithm "${name}"`);
            }
            const bytes = ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data);
            const out = fn(bytes);
            return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
        },
    };

    try {
        Object.defineProperty(cryptoObj, 'subtle', { value: subtle, configurable: true });
    } catch {
        cryptoObj.subtle = subtle;
    }
})();

export {};
