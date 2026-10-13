// Supabase persistence. Each collection of the app state is a table of { id, data jsonb } (see db/schema.sql).
// store.js is the only caller: it loads everything at start, writes the difference after each commit,
// and reloads when another browser changes something.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const enabled = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export class DbError extends Error {
  constructor(message) { super(message); this.name = 'DbError'; }
}

// state key → table, and how to name a record. Records without an id of their own get a composed one.
const COLLECTIONS = {
  skus: ['skus', r => r.id],
  channels: ['channels', r => r.id],
  costBasis: ['cost_basis', r => r.id],
  marginRules: ['margin_rules', r => r.id],
  buffers: ['buffers', r => r.id],
  accounts: ['accounts', r => r.id],
  competitorReadings: ['competitor_readings', r => r.id],
  publications: ['publications', r => `v${r.version}`],
  proposals: ['proposals', r => r.id],
  quotes: ['quotes', r => r.id],
  priceRequests: ['price_requests', r => r.id],
  acknowledgments: ['acknowledgments', r => `${r.userId}|${r.channelId}|${r.boardVersion}`],
  plEmailLog: ['pl_email_log', r => `${r.accountId ?? ''}|${r.channelId ?? ''}|${r.version}|${r.sentAt}`],
  users: ['users', r => r.id],
  events: ['events', r => r.id],
};
// Single-document items (an object or a plain list) live in `settings`, one row each.
const SINGLETONS = ['settings', 'premiumComponents', 'discountComponents', 'trackedBrands', 'zones', 'accessRoles'];

let client = null;
async function sb() {
  if (client) return client;
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  return client;
}

const fail = (what, error) => new DbError(`${what}: ${error?.message || error}`);

async function readAll(c, table) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await c.from(table).select('id,data').range(from, from + 999);
    if (error) throw fail(`Could not read ${table}`, error);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// Returns the full state, or null when the database has no data yet (so the caller can seed it).
export async function loadAll() {
  const c = await sb();
  const state = {};
  let rows = 0;
  await Promise.all(Object.entries(COLLECTIONS).map(async ([key, [table]]) => {
    const list = await readAll(c, table);
    rows += list.length;
    state[key] = list.map(r => r.data);
  }));
  const { data: settings, error } = await c.from('settings').select('key,data');
  if (error) throw fail('Could not read settings', error);
  rows += settings.length;
  for (const r of settings) state[r.key] = r.data;
  if (!rows) return null;
  // Keep the order the app stored lists in (channels, products and zones are user-ordered).
  const order = (await c.from('settings').select('data').eq('key', '_order').maybeSingle()).data?.data || {};
  for (const [key, ids] of Object.entries(order)) {
    const keyFn = COLLECTIONS[key][1], pos = new Map(ids.map((id, i) => [id, i]));
    state[key].sort((a, b) => (pos.get(keyFn(a)) ?? 1e9) - (pos.get(keyFn(b)) ?? 1e9));
  }
  for (const key of SINGLETONS) if (state[key] === undefined) state[key] = key === 'settings' || key === 'accessRoles' ? {} : [];
  return state;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const chunks = (list, n = 400) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
// Lists whose order the user controls; stored so another browser sees the same sequence.
const ORDERED = ['skus', 'channels', 'users'];

// Write only what changed between two states. Events are insert-only.
export async function saveDiff(before, after) {
  const c = await sb();
  const jobs = [];
  for (const [key, [table, keyFn]] of Object.entries(COLLECTIONS)) {
    const was = new Map((before?.[key] || []).map(r => [keyFn(r), r]));
    const now = new Map((after[key] || []).map(r => [keyFn(r), r]));
    const upserts = [...now].filter(([id, r]) => !was.has(id) || !same(was.get(id), r)).map(([id, data]) => ({ id, data }));
    const removed = key === 'events' ? [] : [...was.keys()].filter(id => !now.has(id));
    for (const part of chunks(upserts)) {
      jobs.push(async () => {
        const { error } = key === 'events' ? await c.from(table).insert(part) : await c.from(table).upsert(part);
        if (error) throw fail(`Could not save ${table}`, error);
      });
    }
    for (const part of chunks(removed)) {
      jobs.push(async () => {
        const { error } = await c.from(table).delete().in('id', part);
        if (error) throw fail(`Could not delete from ${table}`, error);
      });
    }
  }
  const rows = SINGLETONS.filter(k => after[k] !== undefined && !same(before?.[k], after[k])).map(k => ({ key: k, data: after[k] }));
  const order = Object.fromEntries(ORDERED.map(k => [k, (after[k] || []).map(COLLECTIONS[k][1])]));
  if (!before || !same(Object.fromEntries(ORDERED.map(k => [k, (before[k] || []).map(COLLECTIONS[k][1])])), order)) rows.push({ key: '_order', data: order });
  if (rows.length) jobs.push(async () => {
    const { error } = await c.from('settings').upsert(rows);
    if (error) throw fail('Could not save settings', error);
  });
  // Deletes and upserts touch different rows, so run them together.
  for (const part of chunks(jobs, 6)) await Promise.all(part.map(j => j()));
}

// Calls onChange(table) when another browser writes. Returns an unsubscribe function.
export async function subscribe(onChange) {
  const c = await sb();
  const ch = c.channel('mgc-pricing')
    .on('postgres_changes', { event: '*', schema: 'public' }, p => onChange(p.table))
    .subscribe();
  return () => c.removeChannel(ch);
}
