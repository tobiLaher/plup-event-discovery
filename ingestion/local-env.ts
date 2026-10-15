// Where the server-side API key comes from. Order: the process environment, then an optional
// git-ignored file (ingestion/local/anthropic.env, one KEY=value per line). The key is never printed;
// callers only learn which source supplied it.
export type KeySource = 'environment' | 'local-file' | 'missing';

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function resolveApiKey(env: Record<string, string | undefined>, localFileText: string | null): { key: string | null; source: KeySource } {
  const fromEnv = env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: 'environment' };
  const fromFile = localFileText ? parseEnvFile(localFileText).ANTHROPIC_API_KEY?.trim() : undefined;
  if (fromFile) return { key: fromFile, source: 'local-file' };
  return { key: null, source: 'missing' };
}

/** Same lookup for any named secret, e.g. GEMINI_API_KEY (environment first, then the ignored local file). */
export function resolveSecret(name: string, env: Record<string, string | undefined>, localFileText: string | null): { key: string | null; source: KeySource } {
  const fromEnv = env[name]?.trim();
  if (fromEnv) return { key: fromEnv, source: 'environment' };
  const fromFile = localFileText ? parseEnvFile(localFileText)[name]?.trim() : undefined;
  if (fromFile) return { key: fromFile, source: 'local-file' };
  return { key: null, source: 'missing' };
}
