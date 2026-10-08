// Workers-compatible replacements for the Node-only bits of
// server/helper.js: cyrb53 (unchanged), randomizer (Web Crypto getRandomValues)
// and hasher (Web Crypto subtle.digest SHA-512 instead of Node's sha3-512).

// cyrb53 (c) 2018 bryc (github.com/bryc)
// Public domain. Attribution appreciated.
export function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// Random string generator matching the original server's printable-char
// filter. Uses Web Crypto getRandomValues (available in Workers).
export function getRandomString(length, lettersOnly = false) {
    const isLetter = r => 65 <= r && r <= 90;
    const isPrintable = r => r === 45 || (47 <= r && r <= 57) || (64 <= r && r <= 90) || (97 <= r && r <= 122);
    const ok = lettersOnly ? isLetter : isPrintable;

    let string = "";
    while (string.length < length) {
        const arr = new Uint16Array(length);
        crypto.getRandomValues(arr);
        for (let i = 0; i < arr.length && string.length < length; i++) {
            const r = arr[i] % 128;
            if (ok(r)) string += String.fromCharCode(r);
        }
    }
    return string;
}

// Replacements for crypto.randomInt(1000000, 1999999).toString().substring(1)
// used to mint 6-digit pair keys (with possible leading zeros).
export function randomPairKey() {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    // [0, 999999] inclusive, zero-padded to 6 digits
    const n = arr[0] % 1000000;
    return n.toString().padStart(6, '0');
}

// SHA-512 based salted hash. The original used sha3-512, which Web Crypto
// does not expose; SHA-512 is the closest supported primitive and is
// collision-resistant enough for authenticating a peer id across reloads.
// The `password` is a per-Durable-Object secret persisted in DO storage so
// peer_id_hash stays valid across DO restarts.
export async function hashCodeSalted(password, salt) {
    const enc = new TextEncoder();
    const pwBuf = await crypto.subtle.digest('SHA-512', enc.encode(password));
    const saltHex = bufToHex(await crypto.subtle.digest('SHA-512', enc.encode(salt)));
    const combined = new Uint8Array(pwBuf.byteLength + saltHex.length);
    combined.set(new Uint8Array(pwBuf), 0);
    combined.set(enc.encode(saltHex), pwBuf.byteLength);
    const digest = await crypto.subtle.digest('SHA-512', combined);
    return bufToHex(digest);
}

function bufToHex(buf) {
    return [...new Uint8Array(buf)]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}
