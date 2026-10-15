// TEST DOUBLE for a Supabase/PostgREST client. It is a small in-memory model of the tables in
// supabase/migrations: unique keys (for upsert onConflict), generated ids, the embedded selects the store uses,
// and the CHECK rules that matter for safety. It records every call and every column written, so tests can
// verify the store's behavior and that written columns exist in the SQL. It is NOT Postgres: real SQL and
// real Row Level Security have not been executed.
import { randomUUID } from 'node:crypto';

type Row = Record<string, any>;
type Err = { message: string; code?: string } | null;

const UNIQUE: Record<string, string[]> = {
  organizers: ['platform', 'handle'],
  source_posts: ['platform', 'source_post_id'],
  source_post_revisions: ['source_post_id', 'content_hash'],
  event_candidates: ['source_post_id'],
  events: ['event_key'],
  event_sources: ['event_id', 'source_post_id'],
  venues: ['slug'],
  venue_evidence: ['venue_id', 'provider', 'place_id'],
  venue_lookup_attempts: ['name_key'],
  extraction_cache: ['cache_key'],
};
const NO_UUID_ID = new Set(['venue_lookup_attempts', 'extraction_cache']);
const IDENTITY = new Set(['event_history', 'ingestion_logs']);

export type FakeCall = { table: string; op: 'select' | 'insert' | 'upsert' | 'update'; onConflict?: string; ignoreDuplicates?: boolean };

export class FakePostgrest {
  readonly tables = new Map<string, Row[]>();
  readonly calls: FakeCall[] = [];
  /** Every column name ever written to each table. */
  readonly writtenColumns = new Map<string, Set<string>>();
  private seq = 0;
  private readonly todayManila: () => string;

  constructor(todayManila: () => string = () => '2026-10-14') {
    this.todayManila = todayManila;
  }

  rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  from(table: string) {
    return new Builder(this, table);
  }

  // ---- internals used by Builder
  note(table: string, row: Row) {
    if (!this.writtenColumns.has(table)) this.writtenColumns.set(table, new Set());
    for (const k of Object.keys(row)) this.writtenColumns.get(table)!.add(k);
  }

  /** The CHECK / FK rules from the migration that guard public data. */
  validate(table: string, row: Row): Err {
    const err = (message: string): Err => ({ message, code: '23514' });
    if (table === 'events') {
      if (!['explicit', 'derived'].includes(row.title_quality)) return err('events_title_quality_check');
      if (!this.rows('venues').some((v) => v.id === row.venue_id)) return { message: 'events_venue_id_fkey', code: '23503' };
      if (!row.event_date) return { message: 'null value in column "event_date"', code: '23502' };
      if (row.end_date && row.end_date < row.event_date) return err('events_check');
      if (!['published', 'unpublished', 'expired'].includes(row.status)) return err('events_status_check');
    }
    if (table === 'source_posts' && row.origin !== 'instagram-business-discovery') return err('source_posts_origin_check');
    if (table === 'venue_evidence' && row.simulated !== false) return err('venue_evidence_simulated_check');
    if (table === 'venues') {
      if (row.verification?.status !== 'verified') return err('venues_verification_check');
      if (!(row.latitude >= 14.35 && row.latitude <= 14.8 && row.longitude >= 120.9 && row.longitude <= 121.2)) return err('venues_coordinates_check');
    }
    if (table === 'event_candidates' && !this.rows('source_posts').some((p) => p.id === row.source_post_id)) return { message: 'event_candidates_source_post_id_fkey', code: '23503' };
    if (table === 'event_sources') {
      if (!this.rows('events').some((e) => e.id === row.event_id)) return { message: 'event_sources_event_id_fkey', code: '23503' };
      if (!this.rows('source_posts').some((p) => p.id === row.source_post_id)) return { message: 'event_sources_source_post_id_fkey', code: '23503' };
    }
    return null;
  }

  withDefaults(table: string, row: Row): Row {
    const out = { ...row };
    if (IDENTITY.has(table)) out.id ??= ++this.seq;
    else if (!NO_UUID_ID.has(table)) out.id ??= randomUUID();
    if (table === 'venue_evidence') out.place_id ??= '';
    return out;
  }

  publicEvents(): Row[] {
    const today = this.todayManila();
    return this.rows('events')
      .filter((e) => e.status === 'published' && (e.end_date ?? e.event_date) >= today)
      .map((e) => {
        const v = this.rows('venues').find((x) => x.id === e.venue_id)!;
        return {
          id: e.id, title: e.title, title_is_generated: e.title_quality === 'derived', description: e.description, category: e.category, genre: e.genre, lineup: e.lineup,
          event_date: e.event_date, end_date: e.end_date, start_time: e.start_time, time_known: e.start_time !== null,
          starts_at: new Date(`${e.event_date}T${e.start_time ?? '12:00:00'}+08:00`).toISOString(),
          ticket_url: e.ticket_url, ticket_price_min: e.ticket_price_min, ticket_price_max: e.ticket_price_max, ticket_is_free: e.ticket_is_free, ticket_info: e.ticket_info,
          source_url: e.source_url, source_label: e.source_label, venue_id: v.id, venue_name: v.name, venue_address: v.address, venue_area: v.area, venue_city: v.city,
          latitude: v.latitude, longitude: v.longitude,
        };
      });
  }
}

class Builder implements PromiseLike<{ data: any; error: Err }> {
  private op: FakeCall['op'] = 'select';
  private payload: Row | Row[] | null = null;
  private onConflict: string | undefined;
  private ignoreDuplicates = false;
  private filters: ((r: Row) => boolean)[] = [];
  private cols = '*';
  private returning = false;
  private mode: 'many' | 'single' | 'maybe' = 'many';
  private orderBy: { col: string; asc: boolean } | null = null;
  private readonly db: FakePostgrest;
  private readonly table: string;

  constructor(db: FakePostgrest, table: string) {
    this.db = db;
    this.table = table;
  }

  select(cols = '*') {
    this.cols = cols;
    if (this.op !== 'select') this.returning = true;
    return this;
  }
  insert(payload: Row | Row[]) {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }
  upsert(payload: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.op = 'upsert';
    this.payload = payload;
    this.onConflict = opts.onConflict;
    this.ignoreDuplicates = opts.ignoreDuplicates ?? false;
    return this;
  }
  update(patch: Row) {
    this.op = 'update';
    this.payload = patch;
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(r[col]));
    return this;
  }
  order(col: string, o: { ascending?: boolean } = {}) {
    this.orderBy = { col, asc: o.ascending ?? true };
    return this;
  }
  single() {
    this.mode = 'single';
    return this;
  }
  maybeSingle() {
    this.mode = 'maybe';
    return this;
  }

  then<R1 = { data: any; error: Err }, R2 = never>(ok?: ((v: { data: any; error: Err }) => R1 | PromiseLike<R1>) | null, bad?: ((e: unknown) => R2 | PromiseLike<R2>) | null) {
    return Promise.resolve(this.run()).then(ok, bad);
  }

  private project(rows: Row[]): Row[] {
    let out = rows.map((r) => ({ ...r }));
    if (this.table === 'venues' && this.cols.includes('venue_evidence(')) out = out.map((v) => ({ ...v, venue_evidence: this.db.rows('venue_evidence').filter((e) => e.venue_id === v.id) }));
    if (this.table === 'event_sources' && this.cols.includes('source_posts(')) {
      out = out.map((s) => ({ ...s, source_posts: this.db.rows('source_posts').find((p) => p.id === s.source_post_id) }));
    }
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      out.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
    }
    return out;
  }

  private finish(rows: Row[]): { data: any; error: Err } {
    if (this.mode === 'single') return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: `expected one row, got ${rows.length}`, code: 'PGRST116' } };
    if (this.mode === 'maybe') return rows.length > 1 ? { data: null, error: { message: 'multiple rows', code: 'PGRST116' } } : { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }

  private run(): { data: any; error: Err } {
    const db = this.db;
    db.calls.push({ table: this.table, op: this.op, onConflict: this.onConflict, ignoreDuplicates: this.ignoreDuplicates || undefined });
    if (this.table === 'public_events') return this.finish(this.project(db.publicEvents().filter((r) => this.filters.every((f) => f(r)))));
    const table = db.rows(this.table);
    if (this.op === 'select') return this.finish(this.project(table.filter((r) => this.filters.every((f) => f(r)))));

    if (this.op === 'update') {
      const hit = table.filter((r) => this.filters.every((f) => f(r)));
      for (const r of hit) {
        const next = { ...r, ...(this.payload as Row) };
        const err = db.validate(this.table, next);
        if (err) return { data: null, error: err };
        Object.assign(r, next);
      }
      db.note(this.table, this.payload as Row);
      return this.returning ? this.finish(this.project(hit)) : { data: null, error: null };
    }

    const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload!]).map((r) => db.withDefaults(this.table, r as Row));
    const keyCols = this.op === 'upsert' ? (this.onConflict ?? 'id').split(',') : (UNIQUE[this.table] ?? []);
    const touched: Row[] = [];
    for (const row of incoming) {
      db.note(this.table, row);
      const dup = table.find((r) => keyCols.length && keyCols.every((c) => r[c] === row[c] && row[c] !== undefined));
      if (this.op === 'insert') {
        if (dup) return { data: null, error: { message: `duplicate key value violates unique constraint on ${this.table}`, code: '23505' } };
        const err = db.validate(this.table, row);
        if (err) return { data: null, error: err };
        table.push(row);
        touched.push(row);
      } else if (dup) {
        if (this.ignoreDuplicates) continue; // existing row is kept untouched
        const merged = { ...dup, ...row, id: dup.id };
        const err = db.validate(this.table, merged);
        if (err) return { data: null, error: err };
        Object.assign(dup, merged);
        touched.push(dup);
      } else {
        const err = db.validate(this.table, row);
        if (err) return { data: null, error: err };
        table.push(row);
        touched.push(row);
      }
    }
    return this.returning ? this.finish(this.project(touched)) : { data: null, error: null };
  }
}
