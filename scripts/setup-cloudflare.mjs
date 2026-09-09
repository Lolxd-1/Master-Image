/**
 * One-time Cloudflare setup.
 *
 * Creates the D1 database and KV namespace, writes their IDs into wrangler.toml, applies the
 * schema, and generates a session secret. Safe to re-run: anything already done is skipped.
 *
 *   npx wrangler login      (once, opens a browser)
 *   npm run setup
 *   npm run deploy
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOML = join(ROOT, 'wrangler.toml');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const say = (m) => console.log(m);
const step = (m) => console.log(`\n▶ ${m}`);

function wrangler(args, { capture = true, input } = {}) {
  return execFileSync(npx, ['wrangler', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32',
  });
}

/* ---------------------------------------------------------------- 0. logged in? */

step('Checking your Cloudflare login');
let account;
try {
  const who = wrangler(['whoami']);
  account = (who.match(/([^\s|]+@[^\s|]+)/) || who.match(/Account Name[^\n]*?\|\s*([^|\n]+)/) || [])[1];
  say(`  Logged in${account ? ` as ${account.trim()}` : ''}.`);
} catch {
  say('\n  You are not logged in to Cloudflare yet.');
  say('  Run this, click "Allow" in the browser window that opens, then run me again:\n');
  say('      npx wrangler login\n');
  process.exit(1);
}

/* ---------------------------------------------------------------- 1. D1 + KV */

let toml = readFileSync(TOML, 'utf8');

if (toml.includes('PLACEHOLDER_D1_ID')) {
  step('Creating the database (D1)');
  let out;
  try {
    out = wrangler(['d1', 'create', 'stock-picker-db']);
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
    if (!/already exists/i.test(out)) { say(out); throw e; }
    say('  Database already exists — looking up its id.');
    out = wrangler(['d1', 'info', 'stock-picker-db']);
  }
  const id = (out.match(/database_id\s*=\s*"([^"]+)"/) || out.match(/([0-9a-f-]{36})/))?.[1];
  if (!id) { say(out); throw new Error('Could not read the database id from wrangler output.'); }
  toml = toml.replace('PLACEHOLDER_D1_ID', id);
  writeFileSync(TOML, toml);
  say(`  Database ready: ${id}`);
} else {
  say('\n▶ Database already configured — skipping.');
}

if (toml.includes('PLACEHOLDER_KV_ID')) {
  step('Creating the file store (KV)');
  let out;
  try {
    out = wrangler(['kv', 'namespace', 'create', 'KV']);
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
    if (!/already exists/i.test(out)) { say(out); throw e; }
    say('  Namespace already exists — looking up its id.');
    out = wrangler(['kv', 'namespace', 'list']);
  }
  const id = (out.match(/id\s*=\s*"([0-9a-f]{32})"/) || out.match(/"id"\s*:\s*"([0-9a-f]{32})"/) || out.match(/([0-9a-f]{32})/))?.[1];
  if (!id) { say(out); throw new Error('Could not read the KV namespace id from wrangler output.'); }
  toml = toml.replace('PLACEHOLDER_KV_ID', id);
  writeFileSync(TOML, toml);
  say(`  File store ready: ${id}`);
} else {
  say('▶ File store already configured — skipping.');
}

/* ---------------------------------------------------------------- 2. schema */

step('Creating the tables');
try {
  wrangler(['d1', 'execute', 'stock-picker-db', '--remote', '--file=./schema.sql', '-y']);
  say('  Tables created.');
} catch (e) {
  const out = `${e.stdout || ''}${e.stderr || ''}`;
  if (/already exists/i.test(out)) say('  Tables already existed — fine.');
  else { say(out); throw e; }
}

/* ---------------------------------------------------------------- 3. session secret */

step('Setting the session secret');
try {
  const existing = wrangler(['secret', 'list']);
  if (existing.includes('SESSION_SECRET')) {
    say('  Already set — leaving it alone (changing it would log everyone out).');
  } else {
    wrangler(['secret', 'put', 'SESSION_SECRET'], { input: randomBytes(32).toString('hex') + '\n' });
    say('  Secret generated and stored.');
  }
} catch {
  wrangler(['secret', 'put', 'SESSION_SECRET'], { input: randomBytes(32).toString('hex') + '\n' });
  say('  Secret generated and stored.');
}

/* ---------------------------------------------------------------- done */

say(`
────────────────────────────────────────────────────
 Setup complete. Now run:

     npm run deploy

 That prints your live link, which you can send to
 the store owners.
────────────────────────────────────────────────────
`);
