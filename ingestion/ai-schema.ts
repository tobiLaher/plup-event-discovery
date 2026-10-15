// Strict schema for model output. The model's reply is untrusted input: it is parsed, type-checked
// and then grounded against the caption (ai-grounding.ts) before anything reaches the pipeline.
// No validation library: the schema is small and a hand-written check keeps dependencies at zero.

export const AI_CLASSES = ['upcoming_event', 'past_event_recap', 'unrelated', 'ambiguous'] as const;
export const AI_UPDATES = ['none', 'cancelled', 'postponed', 'rescheduled', 'updated'] as const;
export const AI_CATEGORIES = ['concert', 'nightlife', 'festival', 'other'] as const;

export type AiClass = (typeof AI_CLASSES)[number];
export type AiUpdate = (typeof AI_UPDATES)[number];

export type AiEvent = {
  /** Official title copied verbatim from the caption. null when the post names none (slogans are not titles). */
  officialTitle: string | null;
  /** A short display label the model generated. Never verified; flagged as generated downstream. */
  displayLabel: string | null;
  artists: { name: string; evidence: string | null }[];
  category: (typeof AI_CATEGORIES)[number] | null;
  date: { value: string | null; endValue: string | null; evidence: string | null };
  startTime: { value: string | null; evidence: string | null };
  venue: { name: string | null; areaClue: string | null; evidence: string | null };
  ticket: { url: string | null; minPhp: number | null; maxPhp: number | null; isFree: boolean | null; evidence: string | null };
};

export type AiResult = {
  id: string;
  classification: AiClass;
  update: AiUpdate;
  event: AiEvent | null;
  notes: string[];
};

export type ParseOutcome<T> = { ok: true; value: T; warnings: string[] } | { ok: false; error: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const KEY_DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

class Bad extends Error {}
const need = (cond: unknown, msg: string): void => {
  if (!cond) throw new Bad(msg);
};

const str = (v: unknown, path: string, max = 300): string | null => {
  if (v === null) return null;
  need(typeof v === 'string', `${path} must be a string or null`);
  const s = (v as string).trim();
  need(s.length <= max, `${path} is too long`);
  return s === '' ? null : s;
};
const num = (v: unknown, path: string): number | null => {
  if (v === null) return null;
  need(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 10_000_000, `${path} must be a non-negative number or null`);
  return v as number;
};
const bool = (v: unknown, path: string): boolean | null => {
  if (v === null) return null;
  need(typeof v === 'boolean', `${path} must be a boolean or null`);
  return v as boolean;
};

function knownKeys(o: Obj, allowed: string[], path: string, warnings: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) warnings.push(`ignored unknown field ${path}.${k}`);
}

function parseEvent(raw: unknown, warnings: string[]): AiEvent | null {
  if (raw === null) return null;
  need(isObj(raw), 'event must be an object or null');
  const e = raw as Obj;
  knownKeys(e, ['officialTitle', 'displayLabel', 'artists', 'category', 'date', 'startTime', 'venue', 'ticket'], 'event', warnings);
  const sub = (k: string, keys: string[]): Obj => {
    need(isObj(e[k]), `event.${k} must be an object`);
    knownKeys(e[k] as Obj, keys, `event.${k}`, warnings);
    return e[k] as Obj;
  };
  need(Array.isArray(e.artists) && (e.artists as unknown[]).length <= 30, 'event.artists must be an array (max 30)');
  const artists = (e.artists as unknown[]).map((a, i) => {
    need(isObj(a), `event.artists[${i}] must be an object`);
    const name = str((a as Obj).name, `event.artists[${i}].name`, 100);
    need(name !== null, `event.artists[${i}].name is required`);
    return { name: name as string, evidence: str((a as Obj).evidence, `event.artists[${i}].evidence`) };
  });
  const cat = e.category;
  need(cat === null || (AI_CATEGORIES as readonly string[]).includes(cat as string), 'event.category is not an allowed value');
  const d = sub('date', ['value', 'endValue', 'evidence']);
  const t = sub('startTime', ['value', 'evidence']);
  const v = sub('venue', ['name', 'areaClue', 'evidence']);
  const k = sub('ticket', ['url', 'minPhp', 'maxPhp', 'isFree', 'evidence']);
  const date = { value: str(d.value, 'date.value', 10), endValue: str(d.endValue, 'date.endValue', 10), evidence: str(d.evidence, 'date.evidence') };
  for (const [name, val] of [['date.value', date.value], ['date.endValue', date.endValue]] as const) need(val === null || KEY_DATE.test(val), `${name} must be YYYY-MM-DD`);
  const time = { value: str(t.value, 'startTime.value', 5), evidence: str(t.evidence, 'startTime.evidence') };
  need(time.value === null || KEY_TIME.test(time.value), 'startTime.value must be HH:mm (24h)');
  return {
    officialTitle: str(e.officialTitle, 'event.officialTitle', 200),
    displayLabel: str(e.displayLabel, 'event.displayLabel', 120),
    artists,
    category: (cat as AiEvent['category']) ?? null,
    date,
    startTime: time,
    venue: { name: str(v.name, 'venue.name', 150), areaClue: str(v.areaClue, 'venue.areaClue', 100), evidence: str(v.evidence, 'venue.evidence') },
    ticket: { url: str(k.url, 'ticket.url', 200), minPhp: num(k.minPhp, 'ticket.minPhp'), maxPhp: num(k.maxPhp, 'ticket.maxPhp'), isFree: bool(k.isFree, 'ticket.isFree'), evidence: str(k.evidence, 'ticket.evidence') },
  };
}

function parseResult(raw: unknown, warnings: string[]): AiResult {
  need(isObj(raw), 'result must be an object');
  const r = raw as Obj;
  // A model-reported confidence is never used for decisions, so it is dropped rather than read.
  for (const bannedKey of ['confidence', 'score', 'probability']) if (bannedKey in r) warnings.push(`ignored ${bannedKey} (publishing never uses model confidence)`);
  const extra = Object.keys(r).filter((k) => !['id', 'classification', 'update', 'event', 'notes', 'confidence', 'score', 'probability'].includes(k));
  for (const k of extra) warnings.push(`ignored unknown field result.${k}`);
  need(typeof r.id === 'string' && r.id.length > 0, 'id is required');
  need((AI_CLASSES as readonly string[]).includes(r.classification as string), 'classification is not an allowed value');
  need((AI_UPDATES as readonly string[]).includes(r.update as string), 'update is not an allowed value');
  need(Array.isArray(r.notes) && (r.notes as unknown[]).every((n) => typeof n === 'string') && (r.notes as unknown[]).length <= 12, 'notes must be an array of strings (max 12)');
  need('event' in r, 'event is required (use null when there is none)');
  return {
    id: r.id as string,
    classification: r.classification as AiClass,
    update: r.update as AiUpdate,
    event: parseEvent(r.event, warnings),
    notes: (r.notes as string[]).map((n) => n.slice(0, 200)),
  };
}

/** Pulls the JSON text out of a reply that may be wrapped in a single code fence. */
export function extractJsonText(text: string): string {
  const t = text.trim();
  const fenced = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : t;
}

/**
 * Recovery for a reply whose whole JSON is broken: split at each `{"id": "` item start and parse every
 * slice on its own. Each recovered item still goes through the full schema and grounding checks;
 * slices that don't parse stay failures. Item starts inside strings can't be mistaken for boundaries
 * because quotes inside JSON strings are escaped (`\"`).
 */
function salvageItems(text: string): { items: Map<string, ParseOutcome<AiResult>>; total: number } | null {
  const body = extractJsonText(text);
  const starts = [...body.matchAll(/\{\s*"id"\s*:\s*"/g)].map((m) => m.index as number);
  if (!starts.length || starts.length > 50) return null;
  const items = new Map<string, ParseOutcome<AiResult>>();
  starts.forEach((s, i) => {
    const slice = body.slice(s, starts[i + 1] ?? body.length).trim().replace(/,\s*$/, '').replace(/\]\s*$/, '');
    const id = slice.match(/^\{\s*"id"\s*:\s*"([^"]{1,100})"/)?.[1] ?? `#${i}`;
    const w: string[] = [];
    try {
      items.set(id, { ok: true, value: parseResult(JSON.parse(slice), w), warnings: w });
    } catch (e) {
      items.set(id, { ok: false, error: e instanceof Bad ? e.message : 'item is not valid JSON' });
    }
  });
  return { items, total: starts.length };
}

/** Parses a batch reply (a JSON array of results). One bad item never invalidates the others. */
export function parseBatchResponse(text: string): { ok: true; items: Map<string, ParseOutcome<AiResult>>; warnings: string[] } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(extractJsonText(text));
  } catch {
    const salvaged = salvageItems(text);
    if (!salvaged) return { ok: false, error: 'response is not valid JSON' };
    const good = [...salvaged.items.values()].filter((o) => o.ok).length;
    return { ok: true, items: salvaged.items, warnings: [`reply was not valid JSON; recovered ${good} of ${salvaged.total} items individually`] };
  }
  if (!Array.isArray(data)) return { ok: false, error: 'response must be a JSON array' };
  if (data.length > 50) return { ok: false, error: 'response has too many items' };
  const items = new Map<string, ParseOutcome<AiResult>>();
  const warnings: string[] = [];
  data.forEach((raw, i) => {
    const w: string[] = [];
    const id = isObj(raw) && typeof raw.id === 'string' ? raw.id : `#${i}`;
    try {
      items.set(id, { ok: true, value: parseResult(raw, w), warnings: w });
    } catch (e) {
      items.set(id, { ok: false, error: e instanceof Bad ? e.message : 'unexpected parse failure' });
    }
  });
  return { ok: true, items, warnings };
}
