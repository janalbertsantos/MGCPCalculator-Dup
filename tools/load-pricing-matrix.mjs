// Loads the 2026-10-13 MGC LPG Pricing Matrix (tools/pricing-matrix-2026-10-13.mjs) into data/seed.json
// as published price list v6: new cost basis, margins per channel and product, and buffers.
// Closes the rows it replaces, so v1-v5 history stays. Bulk is not on the sheet and is left alone.
//   node tools/load-pricing-matrix.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allBoardPrices, priceFor } from '../js/pricing.js';
import { MARGINS, BUFFERS, COST_TOTAL } from './pricing-matrix-2026-10-13.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const seedPath = path.join(root, 'data', 'seed.json');
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
if (seed.publications.some(p => p.version >= 6)) { console.log('Seed already has v6. Nothing to do.'); process.exit(0); }

const DATE = '2026-10-13';
const AT = `${DATE}T01:00:00Z`;
const OBJECTIVE = 'Load the 2026-10-13 MGC LPG Pricing Matrix: cost basis, margins and buffers';

// v5 stops being the live list, so it keeps a snapshot of its own prices.
const v5 = seed.publications.find(p => p.version === 5);
v5.prices = allBoardPrices({ ...seed, accounts: [] });

const changes = [];

// ---- Cost basis: the sheet gives acquisition + hauling together, so hauling keeps its current value.
const cb = seed.costBasis.find(c => c.effectiveTo == null);
const acq = COST_TOTAL - cb.haulingPerKg;
if (acq !== cb.acqPerKg) {
  cb.effectiveTo = DATE;
  seed.costBasis.push({ id: 'cb_m6', acqPerKg: acq, haulingPerKg: cb.haulingPerKg, effectiveFrom: DATE, effectiveTo: null });
  changes.push({ type: 'ACQ', perKg: acq });
}

// ---- Margins
let n = 1;
for (const [channelId, skus] of Object.entries(MARGINS)) {
  for (const r of seed.marginRules.filter(r => r.channelId === channelId && r.effectiveTo == null)) {
    if (skus[r.skuId] === r.perKg) continue;
    r.effectiveTo = DATE; // changed, or no longer sold in this channel
  }
  for (const [skuId, perKg] of Object.entries(skus)) {
    if (seed.marginRules.some(r => r.channelId === channelId && r.skuId === skuId && r.effectiveTo == null)) continue;
    seed.marginRules.push({ id: `mr_m6_${n++}`, channelId, skuId, perKg, effectiveFrom: DATE, effectiveTo: null });
    changes.push({ type: 'MARGIN', channelId, skuId, perKg });
  }
}

// ---- Buffers: a channel default, plus product exceptions
n = 1;
for (const [channelId, b] of Object.entries(BUFFERS)) {
  const wanted = [{ skuId: null, perKg: b.def }, ...Object.entries(b.sku || {}).map(([skuId, perKg]) => ({ skuId, perKg }))];
  for (const w of wanted) {
    const cur = seed.buffers.find(x => x.channelId === channelId && (x.skuId || null) === w.skuId && x.effectiveTo == null);
    if (cur && cur.perKg === w.perKg) continue;
    if (cur) cur.effectiveTo = DATE;
    seed.buffers.push({ id: `buf_m6_${n++}`, channelId, ...(w.skuId ? { skuId: w.skuId } : {}), perKg: w.perKg, effectiveFrom: DATE, effectiveTo: null });
    changes.push({ type: 'BUFFER', channelId, ...(w.skuId ? { skuId: w.skuId } : {}), perKg: w.perKg });
  }
}

// ---- Proposal, events and publication, in the same shape the app writes
const DRAFTER = 'u_mgr_1', APPROVER = 'u_mgr_2', INSTRUCTOR = 'u_admin_1';
const role = id => seed.users.find(u => u.id === id)?.role ?? null;
const cause = `${changes.length} changes from the pricing matrix`;
const id = 'prop_m6';
const ev = (time, actorId, action, extra) => ({
  id: `ev_m6_${action.toLowerCase()}`, timestamp: time, actorId, actorRole: role(actorId), action,
  entity: null, entityId: null, field: null, before: null, after: null, proposalId: null, objective: null,
  instructedBy: null, verifiedBy: null, snapshotHash: null, ...extra,
});
const shift = days => new Date(new Date(AT).getTime() - days * 86400000).toISOString();
seed.proposals.push({ id, objective: OBJECTIVE, changes, draftedBy: DRAFTER, status: 'published', simKey: 'seed-6', instructedBy: INSTRUCTOR, verifiedBy: APPROVER, updatedAt: AT, publishedAt: AT, version: 6 });
seed.events.push(
  ev(shift(3), DRAFTER, 'DRAFT', { entity: 'proposal', entityId: id, proposalId: id, objective: OBJECTIVE, after: { changes, cause } }),
  ev(shift(2.95), DRAFTER, 'SIMULATE', { entity: 'proposal', entityId: id, proposalId: id, objective: OBJECTIVE, after: { changes, cause } }),
  ev(shift(1), APPROVER, 'APPROVE', { entity: 'proposal', entityId: id, proposalId: id, objective: OBJECTIVE, instructedBy: INSTRUCTOR, verifiedBy: APPROVER, after: { draftedBy: DRAFTER, cause } }),
  ev(AT, DRAFTER, 'PUBLISH', { entity: 'publication', entityId: 'board_v6', proposalId: id, objective: OBJECTIVE, instructedBy: INSTRUCTOR, verifiedBy: APPROVER, snapshotHash: 'seed-v6', after: { version: 6, cause, changes, draftedBy: DRAFTER, publishedBy: DRAFTER } }),
);
seed.publications.push({ version: 6, publishedAt: AT, proposalId: id, objective: OBJECTIVE, draftedBy: DRAFTER, instructedBy: INSTRUCTOR, verifiedBy: APPROVER, publishedBy: DRAFTER, snapshotHash: 'seed-v6' });

fs.writeFileSync(seedPath, JSON.stringify(seed, null, 2) + '\n');
console.log(`v6 written: ${changes.length} changes (${changes.filter(c => c.type === 'MARGIN').length} margins, ${changes.filter(c => c.type === 'BUFFER').length} buffers, cost ${changes.some(c => c.type === 'ACQ') ? 'changed' : 'same'})`);

// ---- Check against the sheet: MPL per cylinder (net of VAT) for a sample of cells printed on it
const mplOf = (channelId, skuId) => priceFor({ ...seed, accounts: [] }, { channelId, skuId }).result.netPerCyl / 100;
const SHEET = [
  ['DEALER', '50KG_A', 5163], ['DEALER', '22KG_A', 2294], ['DEALER', '11KG_MGAS', 1147], ['DEALER', '11KG_SULIT', 1086], ['DEALER', 'MINI9', 939], ['DEALER', '5KG_SULIT', 532],
  ['COBANKIAT', '50KG_A', 4900], ['COBANKIAT', '22KG_A', 2156], ['COBANKIAT', '11KG_MGAS', 1078], ['COBANKIAT', '11KG_SULIT', 1023],
  ['COMMERCIAL', '50KG_A', 6013], ['COMMERCIAL', '22KG_A', 2954], ['COMMERCIAL', '22KG_FL_A', 2998], ['COMMERCIAL', '11KG_MGAS', 1493], ['COMMERCIAL', '11KG_SULIT', 1440], ['COMMERCIAL', '2.7KG', 437],
  ['RETAIL_OUTLET', '11KG_MGAS', 1251], ['RETAIL_OUTLET', '11KG_SULIT', 1185], ['RETAIL_OUTLET', '2.7KG', 325], ['RETAIL_OUTLET', '2.7KG_SULIT', 333],
  ['MGSA', '50KG_A', 4850], ['MGSA', '22KG_A', 2134], ['MGSA', '11KG_MGAS', 1067], ['MGSA', '2.7KG', 286], ['MGSA', '2.7KG_SULIT', 304],
  ['END_USER', '50KG_A', 6025], ['END_USER', '22KG_A', 3047], ['END_USER', '11KG_MGAS', 1436], ['END_USER', '11KG_SULIT', 1331], ['END_USER', 'MINI9', 1139], ['END_USER', '5KG_SULIT', 749], ['END_USER', '2.7KG_SULIT', 389],
];
let bad = 0;
for (const [ch, sku, want] of SHEET) {
  const got = Math.round(mplOf(ch, sku));
  if (got !== want) { bad++; console.log(`MISMATCH ${ch} ${sku}: app ${got}, sheet ${want}`); }
}
console.log(`MPL check against the sheet: ${SHEET.length - bad} of ${SHEET.length} match`);
