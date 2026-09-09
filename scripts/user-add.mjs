#!/usr/bin/env node
/**
 * Generates a PBKDF2 salt/hash pair for one user account and prints the exact
 * object-literal line to paste into `worker/users.ts`.
 *
 * Usage:
 *   node scripts/user-add.mjs <username> <password> [role]
 *
 * `role` defaults to "picker" and must be "admin" or "picker" otherwise.
 *
 * The crypto parameters here MUST stay identical to the verifier in
 * `worker/auth.ts` or generated hashes will not validate:
 *   - PBKDF2, SHA-256, 100000 iterations
 *   - 16-byte random salt
 *   - 256-bit (32-byte) derived key
 *   - salt and hash both encoded as standard base64 (RFC 4648, with padding)
 *
 * Node's Web Crypto (`node:crypto`'s `webcrypto`) implements the same
 * standard PBKDF2 algorithm the Workers runtime does, so output produced
 * here is verified compatible with `worker/auth.ts`'s verifier.
 */

import { webcrypto } from 'node:crypto';

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const DERIVED_KEY_BITS = 256;

function usageAndExit(message) {
  if (message) console.error(message);
  console.error('Usage: node scripts/user-add.mjs <username> <password> [role]');
  console.error('  role: "admin" or "picker" (default "picker")');
  process.exit(1);
}

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

async function deriveHash(password, salt) {
  const keyMaterial = await webcrypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await webcrypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    DERIVED_KEY_BITS,
  );
  return new Uint8Array(bits);
}

async function main() {
  const [, , username, password, roleArg] = process.argv;
  const role = roleArg ?? 'picker';

  if (!username || !password) usageAndExit('Username and password are both required.');
  if (role !== 'admin' && role !== 'picker') usageAndExit(`Invalid role "${role}".`);

  const salt = webcrypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveHash(password, salt);

  const saltB64 = bytesToBase64(salt);
  const hashB64 = bytesToBase64(hash);

  console.log('Paste this line into the `users` record in worker/users.ts:');
  console.log('');
  console.log(`  ${username}: { salt: '${saltB64}', hash: '${hashB64}', role: '${role}' },`);
  console.log('');
  console.log('Then redeploy for the change to take effect.');
}

main().catch((err) => {
  console.error('Failed to generate credentials:', err);
  process.exit(1);
});
