// Prototype store: seed load, localStorage persistence, append-only event log.
// Every mutation goes through commit(event, mutationFn). That is the single choke point
// that writes the log. Later this becomes the API layer.

import * as db from './db.js';

const KEY = 'mgc_pricing_v1';
const USER_KEY = 'mgc_pricing_v1_user';

export const ACTIONS = [
  'DRAFT', 'SIMULATE', 'APPROVE', 'PUBLISH', 'QUOTE_SENT', 'REQUEST_LOWER',
  'REQUEST_DECIDED', 'READING_CAPTURED', 'BOARD_ACKNOWLEDGED', 'ACCOUNTS_IMPORTED', 'CONFIG_CHANGED', 'PRICE_LIST_ISSUED', 'CLIENT_TERMS_SAVED', 'PL_EMAIL_SENT',
];

let state = null;
let seed = null;
// 'database' (Supabase), 'local' (no database configured) or 'offline' (configured, but unreachable: using this browser's copy).
let mode = 'local';
let modeNote = '';
const listeners = new Set();

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function lsGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* storage unavailable */ }
}
function lsDel(k) {
  try { localStorage.removeItem(k); } catch { /* storage unavailable */ }
}

export function uid(prefix) {
  const rnd = (crypto.getRandomValues ? crypto.getRandomValues(new Uint32Array(1))[0] : Math.random() * 2 ** 32).toString(36);
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}

export async function sha256(value) {
  const text = JSON.stringify(value);
  if (crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Insecure-context fallback (file://). Clearly labelled so nobody mistakes it for SHA-256.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return 'fnv1a-' + (h >>> 0).toString(16).padStart(8, '0');
}

export async function init() {
  const res = await fetch('data/seed.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load data/seed.json (${res.status})`);
  seed = await res.json();

  // The seed holds configuration; the demo client list is generated separately
  // (tools/make-mock-clients.mjs). Drop the file and the app still runs, with no clients.
  try {
    const mock = await fetch('data/clients.mock.json', { cache: 'no-store' });
    if (mock.ok) {
      const data = await mock.json();
      seed.accounts = [...(seed.accounts || []), ...(data.accounts || [])];
      seed.competitorReadings = [...(seed.competitorReadings || []), ...(data.competitorReadings || [])];
    }
  } catch { /* no mock data file */ }

  let remote = null;
  if (db.enabled) {
    try {
      remote = await db.loadAll();
      mode = 'database';
    } catch (e) {
      mode = 'offline';
      modeNote = e.message;
      console.warn('Database unavailable, using the local copy:', e);
    }
  }
  const loaded = remote ? clone(remote) : null;
  const raw = remote ? null : lsGet(KEY);
  if (remote) {
    state = remote;
  } else if (raw) {
    try { state = JSON.parse(raw); } catch { state = clone(seed); }
    // Bring saved sessions up to date with channels added to the seed later.
    for (const c of seed.channels) if (!state.channels.some(x => x.id === c.id)) state.channels.push(clone(c));
    state.buffers ||= [];
    state.plEmailLog ||= [];
    for (const b of seed.buffers || []) if (!state.buffers.some(x => x.channelId === b.channelId)) state.buffers.push(clone(b));
    // Mock readings added to the seed later, and channel / brand fields on ones saved before they existed.
    for (const r of seed.competitorReadings || []) {
      const have = state.competitorReadings.find(x => x.id === r.id);
      if (!have) state.competitorReadings.push(clone(r));
      else {
        if (have.channelId === undefined && r.channelId) have.channelId = r.channelId;
        if (have.productBrand === undefined && r.productBrand) have.productBrand = r.productBrand;
      }
    }
    addPriceHistory(state, seed);
    addPricingMatrix(state, seed);
  } else {
    state = clone(seed);
  }
  // Access: role defaults live in js/access.js; roles can be edited, users can override.
  state.accessRoles ||= {};
  if (!state.users.some(u => u.role === 'accounting')) {
    state.users.push({ id: 'u_acct_1', name: 'Accounting 1', role: 'accounting', channels: ['*'], canDraft: false, canApprove: false });
  }
  // Managers who could approve before keep that: approving and publishing proposals and deciding price requests.
  for (const u of state.users) {
    if (u.access === undefined && u.role === 'manager' && u.canApprove) u.access = { mpl_approve: 3, mpl_publish: 3, appr_requests: 3 };
  }
  // Every client gets a Client ID; ones already set are kept, the rest start as C-0001, C-0002 and so on.
  const used = new Set(state.accounts.map(a => (a.clientCode || '').toLowerCase()).filter(Boolean));
  let n = 1;
  for (const a of state.accounts) {
    if (a.clientCode !== undefined) continue;
    let code;
    do code = 'C-' + String(n++).padStart(4, '0'); while (used.has(code.toLowerCase()));
    a.clientCode = code;
    used.add(code.toLowerCase());
  }
  // The database starts empty: the first browser to connect loads the demo data into it.
  if (mode === 'database') {
    if (!remote) {
      try { await db.saveDiff(null, state); } catch (e) { mode = 'offline'; modeNote = e.message; }
    }
    else if (loaded) {
      // Persist what the start-up backfills added (a new user, access settings) so other browsers see it.
      try { await db.saveDiff(loaded, state); } catch (e) { console.warn('Could not save start-up updates:', e); }
    }
    if (mode === 'database') watch();
  }
  return state;
}

// A browser saved before the price history existed has only the single "Initial price list" version.
// Give it the seed's five versions, with their proposals, events, notices and past cost and margin rows.
function addPriceHistory(st, sd) {
  const untouched = st.publications.length === 1 && st.publications[0].proposalId == null;
  if (!untouched || sd.publications.length < 2) return;
  st.publications = clone(sd.publications);
  const add = (key, same) => {
    st[key] ||= [];
    for (const r of sd[key] || []) if (!st[key].some(x => same(x, r))) st[key].push(clone(r));
  };
  add('proposals', (a, b) => a.id === b.id);
  add('events', (a, b) => a.id === b.id);
  add('acknowledgments', (a, b) => a.userId === b.userId && a.channelId === b.channelId && a.boardVersion === b.boardVersion);
  add('plEmailLog', (a, b) => a.accountId === b.accountId && a.version === b.version && a.sentAt === b.sentAt);
  for (const r of sd.costBasis) if (r.id.startsWith('cb_h') && !st.costBasis.some(x => x.id === r.id)) st.costBasis.unshift(clone(r));
  for (const r of sd.marginRules) if (r.id.startsWith('mr_h') && !st.marginRules.some(x => x.id === r.id)) st.marginRules.unshift(clone(r));
  st.events.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
}

// A browser saved before the 2026-10-13 pricing matrix has v5 as its newest list. Give it v6:
// the new cost basis, margins and buffers, closing the rows they replace.
function addPricingMatrix(st, sd) {
  const v6 = sd.publications.find(p => p.version === 6);
  if (!v6 || st.publications.reduce((m, p) => Math.max(m, p.version), 0) !== 5) return;
  const date = v6.publishedAt.slice(0, 10);
  const v5 = st.publications.find(p => p.version === 5);
  const sv5 = sd.publications.find(p => p.version === 5);
  if (v5 && !v5.prices && sv5?.prices) v5.prices = clone(sv5.prices);
  st.publications.push(clone(v6));
  for (const key of ['proposals', 'events']) {
    st[key] ||= [];
    for (const r of sd[key] || []) if (r.id.includes('_m6') && !st[key].some(x => x.id === r.id)) st[key].push(clone(r));
  }
  st.events.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  const cb = sd.costBasis.find(c => c.id === 'cb_m6');
  if (cb && !st.costBasis.some(c => c.id === cb.id)) {
    for (const c of st.costBasis) if (c.effectiveTo == null) c.effectiveTo = date;
    st.costBasis.push(clone(cb));
  }
  for (const r of sd.marginRules.filter(r => r.effectiveTo === date))
    for (const o of st.marginRules) if (o.channelId === r.channelId && o.skuId === r.skuId && o.effectiveTo == null) o.effectiveTo = date;
  for (const r of sd.marginRules.filter(r => r.id.startsWith('mr_m6_'))) if (!st.marginRules.some(x => x.id === r.id)) st.marginRules.push(clone(r));
  for (const b of sd.buffers.filter(b => b.id.startsWith('buf_m6_'))) {
    if (st.buffers.some(x => x.id === b.id)) continue;
    for (const o of st.buffers) if (o.channelId === b.channelId && (o.skuId || null) === (b.skuId || null) && o.effectiveTo == null) o.effectiveTo = date;
    st.buffers.push(clone(b));
  }
}

// Another browser changed the database: reload and show it, unless it is what we already have.
let reloadTimer = null;
function watch() {
  db.subscribe(() => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      try {
        const next = await db.loadAll();
        if (next && JSON.stringify(next) !== JSON.stringify(state)) { state = next; lsSet(KEY, JSON.stringify(state)); emit(); }
      } catch { /* keep what is on screen */ }
    }, 400);
  }).catch(e => console.warn('Live updates unavailable:', e));
}

export function status() {
  return { mode, note: modeNote };
}

export function get() {
  return state;
}

export function getSeed() {
  return seed;
}

function save() {
  lsSet(KEY, JSON.stringify(state));
}

function emit() {
  for (const fn of listeners) fn(state);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---- Current user (prototype stand-in for auth; not part of the data) ----

export function currentUser() {
  const id = lsGet(USER_KEY) || 'u_mgr_1';
  return state.users.find(u => u.id === id) || state.users[0];
}

export function setCurrentUser(id) {
  lsSet(USER_KEY, id);
  emit();
}

// ---- The single mutation choke point ----
//
// evt: { action, entity, entityId, field, before, after, proposalId, objective,
//        instructedBy, verifiedBy, hashOf? }
// hashOf (optional) is hashed into snapshotHash and not stored on the event.
// mutationFn(draft, event) mutates a copy of state; it may throw to abort (nothing is written).

export async function commit(evt, mutationFn) {
  if (!ACTIONS.includes(evt.action)) throw new Error(`Unknown action ${evt.action}`);
  const user = currentUser();
  const { hashOf, ...rest } = evt;
  const event = {
    id: uid('ev'),
    timestamp: new Date().toISOString(),
    actorId: user ? user.id : null,
    actorRole: user ? user.role : null,
    action: null, entity: null, entityId: null, field: null, before: null, after: null,
    proposalId: null, objective: null, instructedBy: null, verifiedBy: null, snapshotHash: null,
    ...rest,
  };
  if (hashOf !== undefined) event.snapshotHash = await sha256(hashOf);

  const draft = clone(state);
  const result = mutationFn ? mutationFn(draft, event) : undefined;
  draft.events.push(event);
  // Write to the database first; if it refuses, nothing changes on screen either.
  if (mode === 'database') await db.saveDiff(state, draft);
  state = draft;
  save();
  emit();
  return { event, result };
}

// ---- Demo tools (not domain mutations, so no event) ----

export function reset() {
  lsDel(KEY);
  state = clone(seed);
  save();
  emit();
}

export function exportJson() {
  return JSON.stringify(state, null, 2);
}

export function importJson(text) {
  const next = JSON.parse(text);
  const required = ['costBasis', 'skus', 'channels', 'marginRules', 'accounts', 'users', 'events', 'publications'];
  const missing = required.filter(k => !Array.isArray(next[k]));
  if (missing.length) throw new Error(`Import is missing: ${missing.join(', ')}`);
  for (const k of ['buffers', 'proposals', 'quotes', 'priceRequests', 'acknowledgments', 'competitorReadings'])
    if (!Array.isArray(next[k])) next[k] = [];
  state = next;
  save();
  emit();
}
