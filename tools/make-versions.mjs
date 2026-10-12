// One-time generator: gives data/seed.json five published price versions (v1–v5) of mock history.
// v5 is the current price list, so today's boards and grids are unchanged. Safe to re-run.
//   node tools/make-versions.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allBoardPrices, applyChanges } from '../js/pricing.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const seedPath = path.join(root, 'data', 'seed.json');
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

// ---- Version plan -------------------------------------------------------------------
// margin = today's margin + delta (centavos per kg), per channel.
const BASE_DATE = '2026-08-11'; // v5, the current list
const V = [
  { n: 1, date: '2026-04-14', acq: 5600, haul: 180, d: { BULK: -400, COMMERCIAL: -400, DEALER: -150, RETAIL_OUTLET: -200, COBANKIAT: -150, MGSA: -100, END_USER: -300 },
    objective: 'Initial price list' },
  { n: 2, date: '2026-05-12', acq: 5800, haul: 180, d: { BULK: -400, COMMERCIAL: -400, DEALER: -150, RETAIL_OUTLET: -200, COBANKIAT: -150, MGSA: -100, END_USER: -300 },
    objective: 'Pass on the higher acquisition cost from the May supply contract' },
  { n: 3, date: '2026-06-09', acq: 5800, haul: 180, d: { BULK: -200, COMMERCIAL: -200, DEALER: -150, RETAIL_OUTLET: -200, COBANKIAT: -150, MGSA: -100, END_USER: -300 },
    objective: 'Restore Bulk and Commercial margins after the contract renewals' },
  { n: 4, date: '2026-07-14', acq: 6300, haul: 260, d: { BULK: -200, COMMERCIAL: -200, DEALER: -250, RETAIL_OUTLET: -200, COBANKIAT: -150, MGSA: -100, END_USER: -300 },
    objective: 'July cost increase, with a lower Dealer margin to answer Island Gas on 11 kg' },
  { n: 5, date: BASE_DATE, acq: 6000, haul: 200, d: {},
    objective: 'Cost relief from August supply, margins back to target' },
];
const when = v => `${v.date}T01:00:00Z`;
const at = (v, h, m = 0) => `${v.date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const shiftDays = (iso, days) => new Date(new Date(iso).getTime() + days * 86400000).toISOString();

// ---- Reset anything this script generated before ------------------------------------
seed.marginRules = seed.marginRules.filter(r => !r.id.startsWith('mr_h'));
seed.costBasis = seed.costBasis.filter(c => !c.id.startsWith('cb_h'));
const baseMargin = new Map(seed.marginRules.map(r => [`${r.channelId}|${r.skuId}`, r.perKg]));
const marginAt = (v, r) => baseMargin.get(`${r.channelId}|${r.skuId}`) + (v.d[r.channelId] ?? 0);

// ---- Cost basis and margin history --------------------------------------------------
const costRows = [];
for (let i = 0; i < V.length - 1; i++) {
  const from = V[i], next = V[i + 1];
  const last = costRows[costRows.length - 1];
  if (last && last.acqPerKg === from.acq && last.haulingPerKg === from.haul) { last.effectiveTo = next.date; continue; }
  costRows.push({ id: `cb_h${from.n}`, acqPerKg: from.acq, haulingPerKg: from.haul, effectiveFrom: from.date, effectiveTo: next.date });
}
// v4 and v5 differ, so the v4 row ends where the current row (kept from the seed) begins.
const curCost = seed.costBasis.find(c => c.effectiveTo == null);
curCost.acqPerKg = V[4].acq; curCost.haulingPerKg = V[4].haul; curCost.effectiveFrom = BASE_DATE;
seed.costBasis = [...costRows, curCost];

const marginHist = [];
let hid = 1;
for (const cur of seed.marginRules.filter(r => r.effectiveTo == null)) {
  const key = `${cur.channelId}|${cur.skuId}`;
  const groups = [];
  for (const v of V) {
    const perKg = marginAt(v, cur);
    const g = groups[groups.length - 1];
    if (g && g.perKg === perKg) continue;
    groups.push({ perKg, from: v.date });
  }
  groups.forEach((g, i) => {
    const to = groups[i + 1]?.from ?? null;
    if (to == null) { cur.perKg = g.perKg; cur.effectiveFrom = g.from; }
    else marginHist.push({ id: `mr_h${hid++}`, channelId: cur.channelId, skuId: cur.skuId, perKg: g.perKg, effectiveFrom: g.from, effectiveTo: to });
  });
  void key;
}
seed.marginRules = [...marginHist, ...seed.marginRules];

// ---- Price snapshots per version ----------------------------------------------------
const stateAt = v => ({
  ...JSON.parse(JSON.stringify(seed)),
  costBasis: [{ id: 'x', acqPerKg: v.acq, haulingPerKg: v.haul, effectiveFrom: v.date, effectiveTo: null }],
  marginRules: [...baseMargin].map(([k, perKg]) => {
    const [channelId, skuId] = k.split('|');
    return { id: k, channelId, skuId, perKg: perKg + (v.d[channelId] ?? 0), effectiveFrom: v.date, effectiveTo: null };
  }),
  accounts: [],
});
const snaps = V.map(v => allBoardPrices(stateAt(v)));

// ---- Proposals, publications, events ------------------------------------------------
const changesBetween = (a, b) => {
  const ch = [];
  const acq = b.acq !== a.acq, haul = b.haul !== a.haul;
  if (acq) ch.push({ type: 'ACQ', perKg: b.acq });
  if (haul) ch.push({ type: 'HAULING', perKg: b.haul });
  for (const [k, base] of baseMargin) {
    const [channelId, skuId] = k.split('|');
    const was = base + (a.d[channelId] ?? 0), now = base + (b.d[channelId] ?? 0);
    if (was !== now) ch.push({ type: 'MARGIN', channelId, skuId, perKg: now });
  }
  return ch;
};
const describe = c => c.type === 'ACQ' ? `Acquisition cost to ₱${(c.perKg / 100).toFixed(2)}/kg`
  : c.type === 'HAULING' ? `Hauling to ₱${(c.perKg / 100).toFixed(2)}/kg`
  : `${c.channelId} ${c.skuId} margin to ₱${(c.perKg / 100).toFixed(2)}/kg`;

const DRAFTER = 'u_mgr_1', APPROVER = 'u_mgr_2', INSTRUCTOR = 'u_admin_1';
const role = id => seed.users.find(u => u.id === id)?.role ?? null;
const events = [], proposals = [], publications = [];
let evn = 1;
const ev = (v, time, actorId, action, extra) => events.push({
  id: `ev_h${String(evn++).padStart(3, '0')}`, timestamp: time, actorId, actorRole: role(actorId), action,
  entity: null, entityId: null, field: null, before: null, after: null, proposalId: null, objective: null,
  instructedBy: null, verifiedBy: null, snapshotHash: null, ...extra,
});

publications.push({ version: 1, publishedAt: when(V[0]), proposalId: null, objective: V[0].objective, instructedBy: null, verifiedBy: null, draftedBy: null, publishedBy: null, prices: snaps[0] });
for (let i = 1; i < V.length; i++) {
  const v = V[i], prev = V[i - 1];
  const changes = changesBetween(prev, v);
  const id = `prop_h${v.n}`;
  const cause = changes.length > 6 ? `${changes.slice(0, 3).map(describe).join('; ')}; +${changes.length - 3} more` : changes.map(describe).join('; ');
  const dayBefore = i => shiftDays(when(v), -i);
  proposals.push({ id, objective: v.objective, changes, draftedBy: DRAFTER, status: 'published', simKey: `seed-${v.n}`, instructedBy: INSTRUCTOR, verifiedBy: APPROVER, updatedAt: when(v), publishedAt: when(v), version: v.n });
  ev(v, dayBefore(3), DRAFTER, 'DRAFT', { entity: 'proposal', entityId: id, proposalId: id, objective: v.objective, after: { changes, cause } });
  ev(v, dayBefore(3 - 0.05), DRAFTER, 'SIMULATE', { entity: 'proposal', entityId: id, proposalId: id, objective: v.objective, after: { changes, cause } });
  ev(v, dayBefore(1), APPROVER, 'APPROVE', { entity: 'proposal', entityId: id, proposalId: id, objective: v.objective, instructedBy: INSTRUCTOR, verifiedBy: APPROVER, after: { draftedBy: DRAFTER, cause } });
  ev(v, when(v), DRAFTER, 'PUBLISH', { entity: 'publication', entityId: `board_v${v.n}`, proposalId: id, objective: v.objective, instructedBy: INSTRUCTOR, verifiedBy: APPROVER, snapshotHash: `seed-v${v.n}`, after: { version: v.n, cause, changes, draftedBy: DRAFTER, publishedBy: DRAFTER } });
  publications.push({ version: v.n, publishedAt: when(v), proposalId: id, objective: v.objective, draftedBy: DRAFTER, instructedBy: INSTRUCTOR, verifiedBy: APPROVER, publishedBy: DRAFTER, snapshotHash: `seed-v${v.n}`, ...(v.n === 5 ? {} : { prices: snaps[i] }) });
}
seed.publications = publications;
seed.proposals = proposals;
seed.events = events;

// ---- Notices: v5 partly acknowledged, plus a few emails -----------------------------
const userChannels = u => (u.channels.includes('*') ? seed.channels.map(c => c.id) : u.channels);
const acks = [];
let k = 0;
for (const u of seed.users.filter(u => u.role !== 'messenger')) {
  for (const ch of userChannels(u)) {
    if (k++ % 5 === 4) continue; // about one in five still unseen
    acks.push({ userId: u.id, boardVersion: 5, channelId: ch, acknowledgedAt: shiftDays(when(V[4]), 0.2 + (k % 7) * 0.15) });
  }
}
seed.acknowledgments = acks;

const mockPath = path.join(root, 'data', 'clients.mock.json');
const clients = fs.existsSync(mockPath) ? JSON.parse(fs.readFileSync(mockPath, 'utf8')).accounts || [] : [];
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
seed.plEmailLog = clients.slice(0, 6).map((a, i) => ({
  accountId: a.id, channelId: a.channelId, email: `purchasing@${slug(a.name)}.example.com`, version: 5,
  sentAt: shiftDays(when(V[4]), 0.1 + i * 0.05), status: ['received', 'sent', 'received', 'sent', 'sent', 'received'][i],
}));

fs.writeFileSync(seedPath, JSON.stringify(seed, null, 2) + '\n');
const cur = V[4];
const live = allBoardPrices({ ...seed, accounts: [] });
let diffs = 0;
for (const [ch, rows] of Object.entries(live)) for (const r of rows) {
  const s5 = allBoardPrices(stateAt(cur))[ch].find(x => x.skuId === r.skuId);
  if (!s5 || s5.grossPerCyl !== r.grossPerCyl) diffs++;
}
console.log(`versions: ${publications.length}, proposals: ${proposals.length}, events: ${events.length}, margin history rows: ${marginHist.length}, acks: ${acks.length}, emails: ${seed.plEmailLog.length}`);
console.log(`current board vs v5 snapshot mismatches: ${diffs}`);
void applyChanges;
