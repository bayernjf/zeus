#!/bin/sh
# Generate the Zeus RSK (Roster Signing Key), an Ed25519 keypair in PKCS#8 PEM.
#
#   scripts/gen-rsk-key.sh [path]
#
# Default: writes rsk-private.pem (+ rsk-public.pem) in the current directory.
# The private key seals /api/roster/public snapshots; mount it into the server
# via ZEUS_RSK_KEY (PEM contents) or ZEUS_RSK_KEY_FILE (path), see
# docs/deployment.md. Keep the private key 0600 and out of git.
set -eu

OUT="${1:-rsk-private.pem}"
PUB="${OUT%.pem}.public.pem"

if [ -e "$OUT" ]; then
  echo "refusing to overwrite existing key: $OUT" >&2
  exit 1
fi

umask 077
openssl genpkey -algorithm Ed25519 -out "$OUT"
openssl pkey -in "$OUT" -pubout -out "$PUB" 2>/dev/null
chmod 644 "$PUB"

echo "generated:"
echo "  private: $OUT (keep secret, chmod 600)"
echo "  public:  $PUB (distribute to verifiers / bayjf)"
