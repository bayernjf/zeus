#!/usr/bin/env node
// Generate the Zeus RSK (Roster Signing Key), an Ed25519 keypair in PEM.
//
//   node scripts/gen-rsk-key.mjs [path]
//
// Default: writes rsk-private.pem (+ rsk-private.public.pem) in the current
// directory. Zero dependencies — works on macOS/Linux/Windows and inside the
// container. The private key seals /api/roster/public snapshots; pass it to the
// server via ZEUS_RSK_KEY (PEM contents) or ZEUS_RSK_KEY_FILE (path), see
// docs/deployment.md. Keep the private key 0600 and out of git.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'rsk-private.pem';
const pub = out.endsWith('.pem') ? `${out.slice(0, -4)}.public.pem` : `${out}.public.pem`;

if (existsSync(out) || existsSync(pub)) {
  console.error(`refusing to overwrite existing key: ${existsSync(out) ? out : pub}`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(
  out,
  privateKey.export({ type: 'pkcs8', format: 'pem' }),
  { mode: 0o600 }
);
writeFileSync(
  pub,
  publicKey.export({ type: 'spki', format: 'pem' }),
  { mode: 0o644 }
);

console.log('generated:');
console.log(`  private: ${out} (keep secret, chmod 600)`);
console.log(`  public:  ${pub} (distribute to verifiers / bayjf)`);
