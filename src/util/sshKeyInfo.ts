// What a public key in OpenSSH form says about itself: its type, size,
// comment and SHA256 fingerprint (as `ssh-keygen -l` prints it). Worked out
// here because the vault stores only the key text.

export interface SshKeyInfo {
  /** "ED25519", "RSA", "ECDSA", … */
  type: string;
  /** Key size in bits; null when the blob can't be read. */
  bits: number | null;
  comment: string;
  /** The decoded key blob, for the fingerprint. */
  blob: Uint8Array<ArrayBuffer> | null;
}

const TYPES: Record<string, string> = {
  "ssh-ed25519": "ED25519",
  "ssh-rsa": "RSA",
  "ecdsa-sha2-nistp256": "ECDSA",
  "ecdsa-sha2-nistp384": "ECDSA",
  "ecdsa-sha2-nistp521": "ECDSA",
  "sk-ssh-ed25519@openssh.com": "ED25519-SK",
  "sk-ecdsa-sha2-nistp256@openssh.com": "ECDSA-SK",
  "ssh-dss": "DSA",
};

const decodeBase64 = (text: string): Uint8Array<ArrayBuffer> | null => {
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
};

// The fields of an SSH wire-format blob: each a 32-bit length, then that many bytes.
const fields = (blob: Uint8Array): Uint8Array[] => {
  const out: Uint8Array[] = [];
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let at = 0;
  while (at + 4 <= blob.length) {
    const len = view.getUint32(at);
    at += 4;
    if (at + len > blob.length) break;
    out.push(blob.subarray(at, at + len));
    at += len;
  }
  return out;
};

const bitLength = (mpint: Uint8Array): number => {
  let i = 0;
  while (i < mpint.length && mpint[i] === 0) i++;
  if (i === mpint.length) return 0;
  return (mpint.length - i - 1) * 8 + (32 - Math.clz32(mpint[i]));
};

export function parsePublicKey(text: string): SshKeyInfo | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [algo, b64, ...rest] = parts;
  const blob = decodeBase64(b64);
  const type = TYPES[algo] ?? algo;
  let bits: number | null = null;
  if (blob) {
    if (algo === "ssh-rsa") {
      const f = fields(blob);
      if (f.length >= 3) bits = bitLength(f[2]);
    } else if (algo.includes("ed25519")) {
      bits = 256;
    } else {
      const curve = algo.match(/nistp(\d+)/);
      if (curve) bits = Number(curve[1]);
    }
  }
  return { type, bits, comment: rest.join(" "), blob };
}

/** "SHA256:…" without padding, or null when the key can't be read. */
export async function fingerprint(info: SshKeyInfo | null): Promise<string | null> {
  if (!info?.blob || !globalThis.crypto?.subtle) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", info.blob));
  let bin = "";
  digest.forEach((b) => { bin += String.fromCharCode(b); });
  return "SHA256:" + btoa(bin).replace(/=+$/, "");
}
