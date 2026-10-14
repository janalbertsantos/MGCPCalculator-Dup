// Store-aware selectors around the pure engine: effective-dated lookups, account pricing,
// boards, simulation and approvals. Takes state as an argument; never writes.

import { resolvePrice, derivePremiumPerKg, defaultFloorPerKg } from './engine.js';
import { roundHalfUp, fmt } from './money.js';

const DAY = 86400000;

export const byId = (list, id) => list.find(x => x.id === id);
export const skuLabel = (s, id) => byId(s.skus, id)?.label ?? id;
export const channelLabel = (s, id) => byId(s.channels, id)?.label ?? id;
export function skuDisplayLabel(s, id) {
  const sku = byId(s.skus, id);
  if (!sku) return id;
  if (sku.parentId) return byId(s.skus, sku.parentId)?.label ?? sku.label;
  return sku.label;
}
export const userName = (s, id) => byId(s.users, id)?.name ?? id ?? '—';

export function daysSince(dateStr, now = new Date()) {
  return Math.floor((now - new Date(dateStr)) / DAY);
}

export function fmtDate(d) {
  if (!d) return '—';
  const x = new Date(d);
  return x.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ---- Effective-dated lookups (current version = effectiveTo null) ----

export function currentCostBasis(s) {
  return s.costBasis.find(c => c.effectiveTo == null);
}

export function marginRule(s, channelId, skuId) {
  return s.marginRules.find(r => r.channelId === channelId && r.skuId === skuId && r.effectiveTo == null);
}

// A buffer row with a skuId applies to that product only; one without applies to every product of the channel.
export function bufferFor(s, channelId, skuId) {
  const open = (s.buffers || []).filter(b => b.channelId === channelId && b.effectiveTo == null);
  return (open.find(b => skuId && b.skuId === skuId) ?? open.find(b => !b.skuId))?.perKg ?? 0;
}

export function currentPublication(s) {
  return s.publications.reduce((a, b) => (b.version > a.version ? b : a), s.publications[0]);
}

export function boardIsStale(s) {
  const cb = currentCostBasis(s);
  const pub = currentPublication(s);
  return new Date(cb.effectiveFrom) > new Date(pub.publishedAt);
}

export function skusForChannel(s, channelId) {
  return s.skus.filter(k => k.active && !k.hasVariants && marginRule(s, channelId, k.id));
}

export function zoneOf(s, accountZone) {
  if (!accountZone) return null;
  return s.zones.find(z => accountZone === z || accountZone.startsWith(z)) ?? accountZone;
}

export function userChannels(s, user) {
  if (!user) return [];
  return user.channels.includes('*') ? s.channels.map(c => c.id) : user.channels;
}

// ---- Price requests / approvals ----

export function lineKey(accountId, channelId) {
  return accountId ? accountId : `walkin:${channelId}`;
}

export function pendingRequest(s, key, skuId) {
  return s.priceRequests.find(r => r.lineKey === key && r.skuId === skuId && r.status === 'pending');
}

export function approvedException(s, key, skuId, now = new Date()) {
  return s.priceRequests.find(r => r.lineKey === key && r.skuId === skuId && r.status === 'approved'
    && new Date(r.validUntil) >= now);
}

// ---- Pricing ----

export function priceFor(s, { accountId = null, channelId = null, skuId, quantity = 1, ignoreException = false }) {
  const account = accountId ? byId(s.accounts, accountId) : null;
  const chId = account ? account.channelId : channelId;
  const channel = byId(s.channels, chId);
  const sku = byId(s.skus, skuId);
  const cb = currentCostBasis(s);
  const mr = marginRule(s, chId, skuId);
  if (!channel || !sku || !cb) return { error: 'Pick a customer or channel and a product' };
  if (!mr) return { error: `${sku.label} is not priced for ${channel.label}` };

  const notes = [];
  const premiums = [];
  // A client may carry several rows of the same premium (two installations, two credit exposures).
  for (const p of account?.premiums || []) {
    const comp = s.premiumComponents.find(c => c.code === p.code);
    if (!comp) continue;
    const perKg = p.perKg ?? derivePremiumPerKg(comp, { ...account, investmentCentavos: p.investmentCentavos ?? account.investmentCentavos });
    if (perKg == null) { notes.push(`${comp.label} not applied — the client is missing the inputs for its formula`); continue; }
    premiums.push({ code: comp.code, label: comp.label + (p.note ? ` — ${p.note}` : ''), perKg });
  }
  const discounts = [];
  for (const d of account?.discounts || []) {
    const comp = s.discountComponents.find(c => c.code === d.code);
    if (!comp || !d.perKg) continue;
    discounts.push({ code: comp.code, label: comp.label, perKg: d.perKg });
  }
  const key = lineKey(accountId, chId);
  const exception = ignoreException ? null : approvedException(s, key, skuId);
  if (exception) discounts.push({ code: 'APPROVED_EXCEPTION', label: 'Approved price', perKg: exception.approvedDiscountPerKg });

  // A client with a fixed margin uses it in place of the channel margin.
  const marginPerKg = account?.fixedMarginPerKg ?? mr.perKg;
  const input = {
    costBasis: { acqPerKg: cb.acqPerKg, haulingPerKg: cb.haulingPerKg, effectiveFrom: cb.effectiveFrom },
    sku: { id: sku.id, contentKg: sku.contentKg, label: sku.label },
    channel: { id: channel.id, label: channel.label },
    marginPerKg,
    bufferPerKg: bufferFor(s, chId, skuId),
    premiums,
    discounts,
    quantity,
    vatRate: s.settings.vatRate,
    vatInclusive: s.settings.vatInclusive,
    floorPerKg: account?.floorOverridePerKg ?? defaultFloorPerKg(cb, marginPerKg),
  };
  return { input, result: resolvePrice(input), account, channel, sku, exception, notes, lineKey: key };
}

// Volume prices from the pricing sheet: after the first tier priced at the full MPL, the MPL falls by a fixed amount
// per cylinder at each tier. Retail Outlet also adds an amount per delivery zone. Reference only: quotes do not use it yet.
// Returns { zones, rows: [{ tier, byZone: [centavos per cylinder, before VAT] }] }, or null when the product has no tiers.
export function volumePrices(s, channelId, skuId) {
  const vp = (s.volumePricing || []).find(v => v.channelId === channelId);
  const cfg = vp?.skus[skuId];
  const base = cfg && priceFor(s, { channelId, skuId }).result;
  if (!base) return null;
  const rows = vp.tiers
    .map((tier, i) => (i < cfg.from ? null : { tier, byZone: (vp.zones || [null]).map((_, z) => base.netPerCyl - cfg.step * (i - cfg.from) + (cfg.zoneAdd || 0) * z) }))
    .filter(Boolean);
  return { zones: vp.zones || null, rows };
}

export function boardPrices(s, channelId) {
  return skusForChannel(s, channelId).map(sku => {
    const p = priceFor(s, { channelId, skuId: sku.id, quantity: 1 });
    return { skuId: sku.id, label: sku.label, contentKg: sku.contentKg, netPerKg: p.result.netPerKg, netPerCyl: p.result.netPerCyl, grossPerCyl: p.result.grossPerCyl };
  });
}

export function allBoardPrices(s) {
  return Object.fromEntries(s.channels.map(c => [c.id, boardPrices(s, c.id)]));
}

// ---- Competitor readings ----

export function newestReading(s, { zone, skuId, brand = null }) {
  return s.competitorReadings
    .filter(r => r.zone === zone && (!skuId || r.skuId === skuId) && (!brand || r.brand.toLowerCase() === brand.toLowerCase()))
    .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1))[0] || null;
}

export function isStaleReading(s, r, now = new Date()) {
  return daysSince(r.capturedAt, now) > (s.settings.competitorStaleDays ?? 7);
}

// ---- Change application (used by Simulate and Publish) ----
// Versioned rows are never updated in place: the current row gets effectiveTo, a new row is inserted.

export const CHANGE_TYPES = {
  ACQ: 'Acquisition cost',
  HAULING: 'Hauling',
  MARGIN: 'Channel margin',
  BUFFER: 'Channel buffer',
  ACCOUNT_COMPONENT: 'Client premium or discount',
  ACCOUNT_FIELD: 'Client pricing field', // set from the client pricing grid, not the one-line calculator
};

export const ACCOUNT_FIELDS = {
  fixedMarginPerKg: { label: 'Fixed margin', money: true },
  investmentCentavos: { label: 'Total investment', money: true },
};

// Which catalogue a component code belongs to.
export function componentKind(s, code) {
  if (s.premiumComponents.some(c => c.code === code)) return 'premiums';
  if (s.discountComponents.some(c => c.code === code)) return 'discounts';
  return null;
}

export function componentLabel(s, code) {
  return [...s.premiumComponents, ...s.discountComponents].find(c => c.code === code)?.label ?? code;
}

const rowsTotal = rows => (rows || []).reduce((t, r) => t + (r.perKg || 0), 0);

export function describeChange(s, c) {
  const signed = v => (v > 0 ? '+' : v < 0 ? '−' : '') + (Math.abs(v) / 100).toFixed(2);
  switch (c.type) {
    case 'ACQ': return `acquisition cost ${signed(c.perKg - currentCostBasis(s).acqPerKg)}`;
    case 'HAULING': return `hauling ${signed(c.perKg - currentCostBasis(s).haulingPerKg)}`;
    case 'MARGIN': return `${channelLabel(s, c.channelId)} margin on ${skuLabel(s, c.skuId)} ${signed(c.perKg - (marginRule(s, c.channelId, c.skuId)?.perKg ?? 0))}`;
    case 'BUFFER': return `${channelLabel(s, c.channelId)}${c.skuId ? ' ' + skuLabel(s, c.skuId) : ''} buffer ${signed(c.perKg - bufferFor(s, c.channelId, c.skuId))}`;
    case 'ACCOUNT_COMPONENT': {
      const a = byId(s.accounts, c.accountId);
      const label = componentLabel(s, c.code);
      const rows = c.rows || [];
      if (!rows.length) return `${a?.name} — ${label} removed`;
      const parts = rows.map(r => r.perKg != null ? `${(r.perKg / 100).toFixed(2)}/kg`
        : r.investmentCentavos ? `₱${(r.investmentCentavos / 100).toLocaleString('en-PH')} investment ÷ TRMV`
        : 'catalogue rate');
      const fixed = rowsTotal(rows);
      return `${a?.name} — ${label}: ${parts.join(' + ')}${rows.length > 1 && fixed ? ` (${(fixed / 100).toFixed(2)}/kg fixed)` : ''}`;
    }
    case 'ACCOUNT_FIELD': {
      const a = byId(s.accounts, c.accountId);
      const f = ACCOUNT_FIELDS[c.field];
      const show = v => (v == null ? 'none' : f?.money ? (v / 100).toFixed(2) : v);
      return `${a?.name} — ${f?.label ?? c.field} ${show(a?.[c.field])} → ${show(c.value)}`;
    }
    // Older proposals drafted before premiums and discounts were merged into one type.
    case 'ACCOUNT_PREMIUM':
    case 'ACCOUNT_DISCOUNT': {
      const a = byId(s.accounts, c.accountId);
      return `${a?.name} — ${componentLabel(s, c.code)} ${c.remove ? 'removed' : `set to ${(c.perKg / 100).toFixed(2)}/kg`}`;
    }
    default: return c.type;
  }
}

export function applyChanges(src, changes, when, idFn = p => `${p}_${Math.random().toString(36).slice(2, 9)}`) {
  const s = JSON.parse(JSON.stringify(src));
  const ccb = currentCostBasis(s);
  const acq = changes.find(c => c.type === 'ACQ');
  const haul = changes.find(c => c.type === 'HAULING');
  if (acq || haul) {
    ccb.effectiveTo = when;
    s.costBasis.push({
      id: idFn('cb'), acqPerKg: acq ? acq.perKg : ccb.acqPerKg, haulingPerKg: haul ? haul.perKg : ccb.haulingPerKg,
      effectiveFrom: when, effectiveTo: null,
    });
  }
  for (const c of changes) {
    if (c.type === 'MARGIN') {
      const cur = marginRule(s, c.channelId, c.skuId);
      if (cur) cur.effectiveTo = when;
      s.marginRules.push({ id: idFn('mr'), channelId: c.channelId, skuId: c.skuId, perKg: c.perKg, effectiveFrom: when, effectiveTo: null });
    } else if (c.type === 'BUFFER') {
      const cur = (s.buffers || []).find(b => b.channelId === c.channelId && (b.skuId || null) === (c.skuId || null) && b.effectiveTo == null);
      if (cur) cur.effectiveTo = when;
      (s.buffers ||= []).push({ id: idFn('buf'), channelId: c.channelId, ...(c.skuId ? { skuId: c.skuId } : {}), perKg: c.perKg, effectiveFrom: when, effectiveTo: null });
    } else if (c.type === 'ACCOUNT_COMPONENT') {
      const a = byId(s.accounts, c.accountId);
      const key = componentKind(s, c.code);
      if (!a || !key) continue;
      a[key] = (a[key] || []).filter(x => x.code !== c.code);
      for (const r of c.rows || []) a[key].push({ code: c.code, ...(r.perKg == null ? {} : { perKg: r.perKg }), ...(r.investmentCentavos ? { investmentCentavos: r.investmentCentavos } : {}), ...(r.note ? { note: r.note } : {}) });
    } else if (c.type === 'ACCOUNT_FIELD') {
      const a = byId(s.accounts, c.accountId);
      if (a && ACCOUNT_FIELDS[c.field]) a[c.field] = c.value;
    } else if (c.type === 'ACCOUNT_PREMIUM' || c.type === 'ACCOUNT_DISCOUNT') {
      const a = byId(s.accounts, c.accountId);
      if (!a) continue;
      const key = c.type === 'ACCOUNT_PREMIUM' ? 'premiums' : 'discounts';
      a[key] = (a[key] || []).filter(x => x.code !== c.code);
      if (!c.remove) a[key].push(c.type === 'ACCOUNT_PREMIUM' && c.perKg == null ? { code: c.code } : { code: c.code, perKg: c.perKg });
    }
  }
  return s;
}

// ---- Simulation ----

export function simulate(before, changes, when) {
  const after = applyChanges(before, changes, when);
  const cause = changes.map(c => describeChange(before, c)).join('; ');

  const channelRows = [];
  for (const ch of before.channels) {
    const skuIds = new Set([...skusForChannel(before, ch.id), ...skusForChannel(after, ch.id)].map(k => k.id));
    for (const skuId of skuIds) {
      const b = priceFor(before, { channelId: ch.id, skuId });
      const a = priceFor(after, { channelId: ch.id, skuId });
      const bn = b.result?.netPerKg ?? null, an = a.result?.netPerKg ?? null;
      channelRows.push({
        channelId: ch.id, skuId,
        beforePerKg: bn, afterPerKg: an,
        beforePerCyl: b.result?.netPerCyl ?? null, afterPerCyl: a.result?.netPerCyl ?? null,
        deltaPerKg: bn != null && an != null ? an - bn : null,
        deltaPerCyl: b.result && a.result ? a.result.netPerCyl - b.result.netPerCyl : null,
      });
    }
  }

  const accountRows = [];
  let monthlyImpact = 0;
  const excludedNullVolume = [];
  const newlyBelowFloor = [];
  const crossesCompetitor = [];
  for (const acc of before.accounts.filter(a => a.status === 'Active' && a.primarySkuId)) {
    const b = priceFor(before, { accountId: acc.id, skuId: acc.primarySkuId });
    const a = priceFor(after, { accountId: acc.id, skuId: acc.primarySkuId });
    if (!b.result || !a.result) continue;
    const deltaPerKg = a.result.netPerKg - b.result.netPerKg;
    const vol = acc.avgMonthlyVolumeKg;
    const impact = vol == null ? null : roundHalfUp(deltaPerKg * vol);
    if (vol == null) excludedNullVolume.push(acc.id); else monthlyImpact += impact;
    if (!b.result.belowFloor && a.result.belowFloor) newlyBelowFloor.push({ accountId: acc.id, marginVsFloorPerKg: a.result.marginVsFloorPerKg });
    const r = newestReading(before, { zone: zoneOf(before, acc.zone), skuId: acc.primarySkuId });
    if (r && b.result.grossPerCyl <= r.pricePerCyl && a.result.grossPerCyl > r.pricePerCyl)
      crossesCompetitor.push({ accountId: acc.id, readingId: r.id, afterGrossPerCyl: a.result.grossPerCyl });
    accountRows.push({
      accountId: acc.id, skuId: acc.primarySkuId,
      beforePerKg: b.result.netPerKg, afterPerKg: a.result.netPerKg, deltaPerKg,
      beforePerCyl: b.result.netPerCyl, afterPerCyl: a.result.netPerCyl,
      volumeKg: vol, impact, belowFloorAfter: a.result.belowFloor,
    });
  }

  const review = [
    ...channelRows.filter(r => r.deltaPerCyl).map(r =>
      `${skuLabel(before, r.skuId)}, ${channelLabel(before, r.channelId)}: ${fmt(r.beforePerCyl)} → ${fmt(r.afterPerCyl)} (${r.deltaPerCyl > 0 ? '+' : '−'}${(Math.abs(r.deltaPerCyl) / 100).toFixed(2)}). Cause: ${cause}.`),
    ...channelRows.filter(r => r.beforePerCyl == null && r.afterPerCyl != null).map(r =>
      `${skuLabel(before, r.skuId)}, ${channelLabel(before, r.channelId)}: newly priced at ${fmt(r.afterPerCyl)}. Cause: ${cause}.`),
    ...accountRows.filter(r => r.deltaPerKg && !channelRows.some(c => c.channelId === byId(before.accounts, r.accountId).channelId && c.skuId === r.skuId && c.deltaPerKg === r.deltaPerKg)).map(r =>
      `${byId(before.accounts, r.accountId).name}, ${skuLabel(before, r.skuId)}: ${fmt(r.beforePerCyl)} → ${fmt(r.afterPerCyl)} (${r.afterPerCyl > r.beforePerCyl ? '+' : '−'}${(Math.abs(r.afterPerCyl - r.beforePerCyl) / 100).toFixed(2)}). Cause: ${cause}.`),
  ];

  return { after, cause, channelRows, accountRows, monthlyImpact, excludedNullVolume, newlyBelowFloor, crossesCompetitor, review };
}

// ---- Approvals (rows name accounts, zones or documents — never people) ----

export function exceptions(s, now = new Date()) {
  const rows = [];
  const active = s.accounts.filter(a => a.status === 'Active');

  for (const a of active) {
    if (!a.primarySkuId) continue;
    const p = priceFor(s, { accountId: a.id, skuId: a.primarySkuId });
    if (p.result?.belowFloor)
      rows.push({ kind: 'below_floor', severity: 'red', subject: a.name, entityId: a.id,
        text: `${skuLabel(s, a.primarySkuId)} at ${fmt(p.result.netPerKg)}/kg is ${fmt(-p.result.marginVsFloorPerKg)}/kg below floor` });
  }

  for (const a of active) {
    if (!a.contractEnd) continue;
    const days = Math.ceil((new Date(a.contractEnd) - now) / DAY);
    if (days < 0) rows.push({ kind: 'contract', severity: 'red', subject: a.name, entityId: a.id, text: `Contract expired ${fmtDate(a.contractEnd)}` });
    else if (days <= 30) rows.push({ kind: 'contract', severity: 'amber', subject: a.name, entityId: a.id, text: `Contract expires in ${days} days (${fmtDate(a.contractEnd)})` });
  }

  for (const a of active) {
    if (!a.trmvKg || a.volumeGeneratedKg == null || !a.contractStart || !a.contractEnd) continue;
    const elapsed = Math.min(1, Math.max(0, (now - new Date(a.contractStart)) / (new Date(a.contractEnd) - new Date(a.contractStart))));
    const pace = a.volumeGeneratedKg / a.trmvKg;
    if (pace < elapsed)
      rows.push({ kind: 'trmv', severity: 'amber', subject: a.name, entityId: a.id,
        text: `Behind TRMV pace: ${(pace * 100).toFixed(0)}% of volume at ${(elapsed * 100).toFixed(0)}% of contract time` });
  }

  for (const z of s.zones) {
    const r = newestReading(s, { zone: z });
    if (!r || isStaleReading(s, r, now))
      rows.push({ kind: 'no_reading', severity: 'amber', subject: z, entityId: z,
        text: r ? `No competitor reading in 7 days (last ${fmtDate(r.capturedAt)}, ${daysSince(r.capturedAt, now)} days ago)` : 'No competitor reading on record' });
  }

  for (const z of s.zones) {
    const skuIds = [...new Set(s.competitorReadings.filter(r => r.zone === z).map(r => r.skuId))];
    for (const skuId of skuIds) {
      const r = newestReading(s, { zone: z, skuId });
      const ours = active.filter(a => zoneOf(s, a.zone) === z && a.primarySkuId === skuId)
        .map(a => ({ a, p: priceFor(s, { accountId: a.id, skuId }) }))
        .filter(x => x.p.result && x.p.result.grossPerCyl > r.pricePerCyl);
      for (const { a, p } of ours)
        rows.push({ kind: 'competitor_below', severity: 'amber', subject: z, entityId: a.id,
          text: `${r.brand} ${skuLabel(s, skuId)} at ${fmt(r.pricePerCyl)} (${fmtDate(r.capturedAt)}) is below ${a.name} at ${fmt(p.result.grossPerCyl)}` });
    }
  }

  for (const req of s.priceRequests.filter(r => r.status === 'pending')) {
    const subject = req.accountId ? byId(s.accounts, req.accountId)?.name : `Walk-in, ${channelLabel(s, req.channelId)}`;
    rows.push({ kind: 'request', severity: 'amber', subject, entityId: req.id, requestId: req.id,
      text: `Price request ${req.id.slice(-6)}: ${skuLabel(s, req.skuId)} to ${fmt(req.targetGrossPerCyl)}/cyl (now ${fmt(req.currentGrossPerCyl)})` });
  }

  return rows;
}
