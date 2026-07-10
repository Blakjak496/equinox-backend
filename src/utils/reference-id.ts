import crypto from "crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function toBase32Crockford(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;

    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function generateReferenceId(prefix: string): string {
  const bytes = crypto.randomBytes(8);
  const token = toBase32Crockford(bytes).slice(0, 12);

  return `${prefix}-${token.slice(0, 6)}-${token.slice(6, 12)}`;
}
