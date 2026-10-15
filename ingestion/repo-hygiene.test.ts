/// <reference types="node" />
// Run: npm run ingest:test
//
// Pre-publication guard for the whole repository (not just the ingestion code). It reads the files git tracks
// and checks that no secrets, real organizer/third-party data, personal identifiers or env files are
// committed, that env templates hold only placeholders, and that client code cannot reach server keys.
// Forbidden real-data words are stored as SHA-256 hashes, so this file does not itself contain them.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });
const tracked = git('ls-files').split('\n').filter(Boolean);
const BINARY = /\.(png|jpe?g|gif|ico|icns|ttf|otf|woff2?|mp4|zip|icon)$/i;
const textFiles = tracked.filter((f) => !BINARY.test(f) && f !== 'package-lock.json');
const read = (f: string) => readFileSync(f, 'utf8');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** SHA-256 of lowercase tokens that must never appear in tracked files: real organizer/event/artist names, real IDs, personal handles. */
const FORBIDDEN_HASHES = new Set([
  '10f577cb60e6d2b2dd4569b0396f8ea42482bbe68a41402724ae9d9aca532871',
  '3f577947b434f0984eb2406ec0a36c597f50838c74e483c3d792cc7952170b2e',
  'c521703008b012c6b9aff449b9489f177cd672adb33aadb48e5c09acdb31fe20',
  'a4ba0ac1ac99cf4a688317734a4ee141405f2ac1a90b8e5de5af38c646127602',
  '04ca9ab8cdb00964368c93440750065bfe4a34304ce3626d0caca017c40a4e65',
  '083e6ebd8e423f17e41f6609512d6dce6755252557ecf40a34ed067188c41038',
  '32e12f01402709d1541bd61ee8fa3b26cd9fea8516e6aec68140ee72cdb8ab70',
  'bffde9b0ab2d630097f7679f271943c3ec490f4152bea05eec491913bb4e8472',
  '08c8bc5087cf619961b118d3958ea6d04ab3ff935c4d4bb18a0e47c8183967d0',
  'cc4a136a27b4c63d8c349413d08a11b9c973c6487c1bd5aa7069e7eed1c57e17',
  '6c2648429e1589c210cab6ae8048bbde5aa80557183cfddff88a5b9f4e6222db',
  '59d58800aeb5ca90a228454bd304b63337ea1e42ab404d5c193b7949cbcfb15a',
  'a09686875bdd90aa9646a50490855408af6d29e9592a8a3980927e45ab02dc20',
  '9dd44fc9e010652ae3b02868fb8bdb0d1c295ab978a04bea7de2d87bb8c75d5f',
  '7a0302ff8aa5c5fb16a248e4fe8063572efd763c412c9cfc9290bfbeb2ae6107',
  'f9f7948893546b684eb4d916aae95f01a6607202dcf9b6ba59f9e4024a6017c0',
  'eee7178d5693ae0ae9e1b7cfe45e299dc709aafbb2d963cb09fa98a09d0670fe',
  '2cd1089111be2467563f0bee7b23482a10b797ddae015def155743d5907be251',
]);

test('no real organizer, event, artist or account identifiers appear in tracked files', () => {
  const found: string[] = [];
  for (const f of textFiles) {
    for (const token of new Set(read(f).toLowerCase().split(/[^a-z0-9]+/))) {
      if (token.length >= 4 && FORBIDDEN_HASHES.has(sha(token))) found.push(`${f} (token hash ${sha(token).slice(0, 8)})`);
    }
  }
  assert.deepEqual(found, []);
});

/** Credential shapes. A match is allowed only when the string is plainly a placeholder. */
const SECRET_PATTERNS: [string, RegExp][] = [
  ['Google API key', /AIza[0-9A-Za-z_-]{20,}/g],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{10,}/g],
  ['Supabase secret key', /sb_secret_[A-Za-z0-9_-]{10,}/g],
  ['JWT', /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g],
  ['Meta/Facebook access token', /EAA[A-Za-z0-9]{30,}/g],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{30,}/g],
  ['AWS access key id', /AKIA[0-9A-Z]{16}/g],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
];
const PLACEHOLDER = /FAKE|PLACEHOLDER|NOT[-_]REAL|EXAMPLE|abcdefghijklmnop|different_value/i;

test('no credential-shaped strings are tracked (only obvious placeholders in tests)', () => {
  const found: string[] = [];
  for (const f of textFiles) {
    const text = read(f);
    for (const [name, re] of SECRET_PATTERNS) {
      for (const m of text.matchAll(re)) if (!PLACEHOLDER.test(m[0])) found.push(`${f}: ${name}`);
    }
  }
  assert.deepEqual(found, []);
});

test('no env files, key files or local data are tracked; only placeholder templates are', () => {
  const sensitive = tracked.filter((f) => /(^|\/)\.env(\.|$)|\.pem$|\.key$|\.p12$|\.p8$|\.jks$|keystore|credentials\.json|service-account|google-services|GoogleService-Info|\.npmrc$|\.netrc$/i.test(f));
  assert.deepEqual(sensitive.sort(), ['.env.example', 'ingestion/.env.example']);
  assert.deepEqual(tracked.filter((f) => f.startsWith('ingestion/local/')), []);
  assert.deepEqual(tracked.filter((f) => /^(CLAUDE\.md|AGENTS\.md|\.claude\/)/.test(f)), []); // assistant working files stay local
  assert.deepEqual(tracked.filter((f) => /(^|\/)(node_modules|\.expo|dist|web-build|ios|android)\//.test(f)), []);
});

test('env templates contain only empty placeholder values and warn against public secrets', () => {
  for (const f of ['.env.example', 'ingestion/.env.example']) {
    const lines = read(f).split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
    assert.ok(lines.length > 0, f);
    for (const l of lines) assert.match(l, /^[A-Z0-9_]+=$/, `${f}: ${l.split('=')[0]} must be empty`);
  }
  assert.match(read('.env.example'), /NEVER put a service-role/);
  const rootNames = read('.env.example').split(/\r?\n/).filter((l) => /^[A-Z]/.test(l)).map((l) => l.split('=')[0]);
  assert.deepEqual(rootNames, ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY']);
  const serverNames = read('ingestion/.env.example').split(/\r?\n/).filter((l) => /^[A-Z]/.test(l)).map((l) => l.split('=')[0]);
  assert.ok(serverNames.every((n) => !n.startsWith('EXPO_PUBLIC_')));
});

test('.gitignore blocks env files, keys, local data and build output, but allows the templates', () => {
  const ignored = (p: string) => {
    try {
      execFileSync('git', ['check-ignore', '-q', p]);
      return true;
    } catch {
      return false;
    }
  };
  for (const p of ['.env', '.env.local', '.env.production', 'ingestion/local/real-posts.json', 'ingestion/local/gemini.env', 'supabase/.env', 'server.env', 'key.pem', 'node_modules/x/index.js', '.expo/x', 'ios/Podfile', 'debug.log']) {
    assert.ok(ignored(p), `${p} should be ignored`);
  }
  for (const p of ['.env.example', 'ingestion/.env.example', 'src/app/index.tsx', 'supabase/migrations/x.sql']) assert.equal(ignored(p), false, `${p} should not be ignored`);
});

test('client code cannot reach server keys: no server key names, no ingestion imports, only EXPO_PUBLIC_* env reads', () => {
  const client = tracked.filter((f) => (f.startsWith('src/') || f === 'app.json') && !BINARY.test(f));
  const problems: string[] = [];
  for (const f of client) {
    const t = read(f);
    if (/SERVICE_ROLE|GEMINI|ANTHROPIC|sb_secret_|service_role|from ['"][^'"]*ingestion\//.test(t)) problems.push(`${f}: server key name or ingestion import`);
    for (const m of t.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      if (!m[1].startsWith('EXPO_PUBLIC_') && m[1] !== 'EXPO_OS') problems.push(`${f}: reads ${m[1]}`); // EXPO_OS is a built-in Expo constant
    }
  }
  assert.deepEqual(problems, []);
  for (const f of tracked) {
    if (BINARY.test(f) || f === 'package-lock.json') continue;
    assert.doesNotMatch(read(f), /EXPO_PUBLIC_[A-Z_]*(SERVICE|SECRET|GEMINI|ANTHROPIC|PRIVATE|ADMIN)/i, `${f} defines a secret-named public variable`);
  }
});

test('the app\'s Supabase client uses only the public URL and publishable key', () => {
  const t = read('src/lib/supabase.ts');
  const reads = [...t.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(reads, ['EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'EXPO_PUBLIC_SUPABASE_URL']);
});

test('the Supabase migration contains no credentials and the SQL never grants private tables to public roles', () => {
  const sql = tracked.filter((f) => f.endsWith('.sql')).map(read).join('\n');
  assert.doesNotMatch(sql, /eyJ[A-Za-z0-9_-]{15,}|sb_secret_|password\s*=/i);
});
