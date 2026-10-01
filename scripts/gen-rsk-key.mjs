#!/usr/bin/env node
// @ts-check
// Generate the Zeus RSK (Roster Signing Key), an Ed25519 keypair in PEM.
//
//   node scripts/gen-rsk-key.mjs [path]
//
// Default: writes rsk-private.pem (+ rsk-private.public.pem) in the current
// directory. Zero dependencies — works on macOS/Linux/Windows and inside the
// container. The private key seals /api/roster/public snapshots; pass it to the
// server via ZEUS_RSK_KEY (PEM contents) or ZEUS_RSK_KEY_FILE (path), see
// docs/deployment.md. Keep the private key 0600 and out of git.
//
// It also prints the value to announce out of band (design-fealty-signing §5.1:
// verifiers pin the RFC 7638 thumbprint). That number is computed by the same
// shipped function the publication endpoint uses, on purpose: if this script
// hashed the key its own way, a divergence between the two would corrupt every
// pin made from it, which is precisely the failure the announcement exists to
// prevent.
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

// The fingerprints depend only on the key material, so the label is decorative
// here; the real keyId comes from ZEUS_RSK_KEY_ID at serving time.
let publishRootKey;
try {
  ({ publishRootKey } = await import('../dist/registry/signing.js'));
} catch (error) {
  console.log(`  pinning value: not computed - ${String(error instanceof Error ? error.message : error).split('\n')[0]}`);
  console.log('    run `npm run build` and generate again, or read it from a running');
  console.log('    server at GET /api/roster/keys - same function, same value.');
  process.exit(0);
}
const published = publishRootKey(process.env.ZEUS_RSK_KEY_ID ?? 'unlabelled', publicKey);
console.log('  pin this value out of band (it is what verifiers compare against):');
console.log(`    jwkThumbprint  ${published.jwkThumbprint}   (RFC 7638; announce this one)`);
console.log(`    spkiSha256     ${published.spkiSha256}`);
console.log(`  keyId at serving time comes from ZEUS_RSK_KEY_ID (currently: ${process.env.ZEUS_RSK_KEY_ID ?? '(unset -> zeus-rsk-dev)'})`);
