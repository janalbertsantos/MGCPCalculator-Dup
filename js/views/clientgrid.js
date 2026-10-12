// Client pricing grid — every client of one channel on a single page.
// Rows are clients; columns are the line types. Fields open with the client's last saved amounts.
// One Save button: price levers go into the open MPL proposal, the rest is saved as client terms.

import * as store from '../store.js';
import { fmt, fmtKg, toCentavos, toInput } from '../money.js';
import { esc, toast, preserveFocus } from '../ui.js';
import { byId, priceFor, currentCostBasis, bufferFor, channelLabel, skuLabel } from '../pricing.js';
import { derivePremiumPerKg } from '../engine.js';
import { FIELDS, labelFor, displayValue } from '../clientterms.js';
import { inRange, rangeActive, rangeBar } from '../pricerange.js';
import * as wizard from './priceroom-wizard.js';

const ui = { channelId: 'COMMERCIAL', expanded: {}, rows: {}, filterQuery: '', selectedIds: null, filterOpen: false, filterScroll: 0 };

// Two column groups, each with its own subcolumns. Every cell takes as many rows as the client needs.
const PREMIUM_COLS = [
  { code: 'ROI_INSTALL', title: 'Installation cost for ROI', note: 'Investment ₱ · ₱/kg · note', roi: true },
  { code: 'CREDIT_RISK', title: 'Credit risk / bad debts', note: '₱/kg · note' },
];
const DISCOUNT_COLS = [
  { code: 'SUPPLY_ONLY', title: 'Supply only', note: '₱/kg · note' },
  { code: 'DUAL_SUPPLIER', title: 'Competition (dual supplier)', note: '₱/kg · note' },
  { code: 'CASH_ZERO', title: 'Cash / zero-rated (short term)', note: '₱/kg · note' },
];
const COLS = [...PREMIUM_COLS, ...DISCOUNT_COLS];

// Field definitions live in clientterms.js; this screen only reads them.

export function setChannel(id) {
  ui.channelId = id;
}

export function isFilterOpen() { return ui.filterOpen; }
export function closeFilter() { ui.filterOpen = false; }

// ---- Editing state: drafts start from what is saved, so fields open pre-filled ----

const rowKey = (accId, code) => `${accId}|${code}`;
const listFor = (a, code) => (DISCOUNT_COLS.some(c => c.code === code) ? a.discounts : a.premiums) || [];

function currentRows(a, code) {
  return listFor(a, code).filter(p => p.code === code).map(p => ({
    perKg: p.perKg == null ? '' : toInput(p.perKg),
    investment: p.investmentCentavos ? toInput(p.investmentCentavos) : '',
    note: p.note || '',
  }));
}

function draftRows(a, code) {
  return ui.rows[rowKey(a.id, code)] ?? currentRows(a, code);
}

function editRows(a, code) {
  const k = rowKey(a.id, code);
  if (!ui.rows[k]) ui.rows[k] = currentRows(a, code);
  if (!ui.rows[k].length) ui.rows[k] = [{ perKg: '', investment: '', note: '' }];
  return ui.rows[k];
}

// Live total of every premium on the client: the two grid columns plus any other premium it carries,
// including premiums that take their rate from the catalogue or from a formula.
export function premiumTotal(s, a) {
  let total = 0;
  const gridCodes = PREMIUM_COLS.map(c => c.code);
  for (const col of PREMIUM_COLS) {
    for (const r of draftRows(a, col.code)) {
      const perKg = toCentavos(r.perKg);
      if (perKg != null) { total += perKg; continue; }
      const investment = toCentavos(r.investment);
      if (investment && a.trmvKg) total += Math.round(investment / a.trmvKg);
    }
  }
  const other = (a.premiums || []).filter(p => !gridCodes.includes(p.code));
  const otherTotal = other.reduce((t, p) => {
    const comp = s.premiumComponents.find(c => c.code === p.code);
    const perKg = p.perKg ?? (comp ? derivePremiumPerKg(comp, { ...a, investmentCentavos: p.investmentCentavos ?? a.investmentCentavos }) : null);
    return t + (perKg ?? 0);
  }, 0);
  return { total: total + otherTotal, otherTotal, otherCount: other.length };
}

export function pendingEdits() {
  return Object.keys(ui.rows).length;
}

// ---- Render ----

export function html(s) {
  const allClients = s.accounts.filter(a => a.channelId === ui.channelId);
  if (ui.selectedIds === null) ui.selectedIds = new Set(allClients.map(a => a.id));
  const selected = allClients.filter(a => ui.selectedIds.has(a.id));
  const grossOf = a => { const p = a.primarySkuId ? priceFor(s, { accountId: a.id, skuId: a.primarySkuId }) : null; return p && !p.error ? p.result.grossPerCyl : null; };
  const clients = rangeActive() ? selected.filter(a => inRange(grossOf(a))) : selected;
  const cb = currentCostBasis(s);
  const edits = pendingEdits();

  const chSel = `<select id="cg-ch" aria-label="Channel">${s.channels.map(c => `<option value="${esc(c.id)}"${c.id === ui.channelId ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`;

  const q = ui.filterQuery.toLowerCase();
  const filtered = q ? allClients.filter(a => a.name.toLowerCase().includes(q) || (a.zone || '').toLowerCase().includes(q)) : allClients;
  const allChecked = allClients.length === selected.length;

  const filterHtml = `<div class="multi" id="cg-multi">
      <button type="button" id="cg-toggle" class="multi-btn" aria-haspopup="listbox" aria-expanded="${ui.filterOpen}">
        <span>Clients <b>${selected.length}</b>/${allClients.length}</span><span aria-hidden="true">▾</span></button>
      ${ui.filterOpen ? `<div class="multi-menu cg-filter-menu">
        <input id="cg-search" type="search" autocomplete="off" placeholder="Search client or zone" aria-label="Search clients" value="${esc(ui.filterQuery)}">
        <div class="multi-actions small"><label class="check"><input type="checkbox" id="cg-all" ${allChecked ? 'checked' : ''}> All (${allClients.length})</label>
          <span class="muted">${selected.length} shown</span></div>
        <div id="cg-list" class="multi-list" role="listbox" aria-multiselectable="true" aria-label="Clients">${filtered.map(a =>
          `<label class="multi-opt"><input type="checkbox" data-cg-sel="${esc(a.id)}" ${ui.selectedIds.has(a.id) ? 'checked' : ''}>
            <span class="grow">${esc(a.name)}</span><span class="small muted">${esc(a.zone ?? '—')}</span></label>`).join('')}
        </div>
      </div>` : ''}
    </div>`;

  return `<div class="one-row">${chSel}${filterHtml}${rangeBar(clients.length, selected.length, 'clients', selected.map(grossOf))}
      <span class="small muted nowrap">${clients.length}${edits ? ` · ${edits} unsaved` : ''}</span>
      <button type="button" id="cg-save" class="primary small" ${edits ? '' : 'disabled'}>Save</button></div>
    ${clients.length ? `<table class="matrix grid-table">
      <thead>
      <tr class="grp">
        <th rowspan="2" class="col-client">Client</th>
        <th rowspan="2" class="num col-price">Current price</th>
        <th colspan="${PREMIUM_COLS.length + 1}" class="grp-prem">Premiums</th>
        <th colspan="${DISCOUNT_COLS.length + 1}" class="grp-disc">Discounts</th>
      </tr>
      <tr>
        <th class="num grp-prem-sub col-total">Total premium</th>
        ${PREMIUM_COLS.map(c => `<th class="col-line">${esc(c.title)}</th>`).join('')}
        <th class="num grp-disc-sub col-total">Total discounts</th>
        ${DISCOUNT_COLS.map(c => `<th class="col-line">${esc(c.title)}</th>`).join('')}
      </tr></thead>
      <tbody>${clients.map(a => clientRow(s, a, cb)).join('')}</tbody>
    </table>` : '<p class="muted">No clients match the filter or price range.</p>'}`;
}

function clientRow(s, a, cb) {
  const open = !!ui.expanded[a.id];
  const p = a.primarySkuId ? priceFor(s, { accountId: a.id, skuId: a.primarySkuId }) : null;
  let price = '<span class="muted small">No main product</span>';
  if (p && !p.error) {
    const margin = p.input.marginPerKg;
    const buffer = p.input.bufferPerKg || 0;
    price = `<span class="cell-price" title="MPL ${fmt(cb.acqPerKg + margin)} (acq + margin) · margin + buffer ${fmt(margin + buffer)}">${fmt(p.result.grossPerCyl)}</span> <span class="small muted">${esc(skuLabel(s, a.primarySkuId))}</span>`;
  } else if (p?.error) price = `<span class="muted small">${esc(p.error)}</span>`;

  const volGen = a.volumeGeneratedKg != null ? Number(a.volumeGeneratedKg).toLocaleString('en-PH') + ' kg' : '—';
  const reqVol = a.reqVolPerMonthKg != null ? Number(a.reqVolPerMonthKg).toLocaleString('en-PH') + ' kg' : '—';

  return `<tr>
      <th scope="row" title="${esc(`${a.clientCode ? a.clientCode + ' · ' : ''}${a.status} · ${a.zone ?? '—'} · Gen vol ${volGen} · Req/mo ${reqVol}`)}">
        <button type="button" class="link exp" data-cg-exp="${esc(a.id)}" aria-expanded="${open}">${open ? '▾' : '▸'} ${esc(a.name)}</button>
      </th>
      <td class="num">${price}</td>
      <td class="num grp-prem-sub" id="tp-${esc(a.id)}">${totalCell(s, a)}</td>
      ${PREMIUM_COLS.map(c => `<td>${cellRows(a, c)}</td>`).join('')}
      <td class="num grp-disc-sub" id="td-${esc(a.id)}">${discountCell(a)}</td>
      ${DISCOUNT_COLS.map(c => `<td>${cellRows(a, c)}</td>`).join('')}
    </tr>
    ${open ? `<tr class="prof"><td colspan="${4 + COLS.length}">${profileBox(a)}</td></tr>` : ''}`;
}

function totalCell(s, a) {
  const { total, otherTotal, otherCount } = premiumTotal(s, a);
  return `<span class="cell-price" ${otherCount ? `title="incl. ${otherCount} other premium${otherCount === 1 ? '' : 's'} ${fmt(otherTotal)}"` : ''}>${fmt(total)}</span>`;
}

// Live total of the client's discounts, from the three columns plus anything else it carries.
export function discountTotal(a) {
  const gridCodes = DISCOUNT_COLS.map(c => c.code);
  let total = 0;
  for (const col of DISCOUNT_COLS) for (const r of draftRows(a, col.code)) total += toCentavos(r.perKg) ?? 0;
  const other = (a.discounts || []).filter(d => !gridCodes.includes(d.code));
  const otherTotal = other.reduce((t, d) => t + (d.perKg ?? 0), 0);
  return { total: total + otherTotal, otherTotal, otherCount: other.length };
}

function discountCell(a) {
  const { total, otherTotal, otherCount } = discountTotal(a);
  return `<span class="cell-price" ${otherCount ? `title="incl. ${otherCount} other ${fmt(otherTotal)}"` : ''}>${total ? '−' : ''}${fmt(total)}</span>`;
}

// One row of fields per client and line type. Any extra rows a client already carries are kept as they are.
// Amounts are money: two decimals, never negative.
function cellRows(a, col) {
  const rows = draftRows(a, col.code);
  const r = rows[0] || { perKg: '', investment: '', note: '' };
  const extra = Math.max(0, rows.length - 1);
  const amount = `<input class="mini" type="number" min="0" step="0.01" inputmode="decimal" placeholder="₱/kg" value="${esc(r.perKg)}" aria-label="Per kg" data-cg="${esc(a.id)}|${col.code}|0|perKg">`;
  return `<div class="cellfields">
    ${amount}
  </div>`;
}

// View only, and kept tight. These are maintained in Configuration → Clients.
const INLINE_KEYS = new Set(['volumeGeneratedKg', 'reqVolPerMonthKg']);
function profileBox(a) {
  return `<div class="terms-line">
    ${FIELDS.filter(f => !INLINE_KEYS.has(f.key)).map(f => `<span class="term"><i>${esc(labelFor(f))}</i>${esc(displayValue(a, f))}</span>`).join('')}
    <a class="term-edit small" href="#/config">Edit terms</a>
  </div>`;
}

// ---- Save ----

async function saveAll(rerender) {
  const s = store.get();
  const changes = [];

  // Premium and discount rows → one change per client and code.
  for (const [key, rows] of Object.entries(ui.rows)) {
    const [accId, code] = key.split('|');
    const a = byId(s.accounts, accId);
    if (!a) continue;
    const next = rows
      .map(r => ({ perKg: toCentavos(r.perKg), investmentCentavos: toCentavos(r.investment), note: (r.note || '').trim() }))
      .filter(r => r.perKg != null || r.investmentCentavos != null || r.note)
      .map(r => ({ ...(r.perKg == null ? {} : { perKg: r.perKg }), ...(r.investmentCentavos ? { investmentCentavos: r.investmentCentavos } : {}), ...(r.note ? { note: r.note } : {}) }));
    const before = listFor(a, code).filter(p => p.code === code).map(({ code: _c, ...rest }) => rest);
    if (JSON.stringify(before) !== JSON.stringify(next)) changes.push({ type: 'ACCOUNT_COMPONENT', accountId: accId, code, rows: next });
  }

  const total = changes.length ? wizard.addChanges(changes) : 0;

  ui.rows = {};
  rerender();
  if (!changes.length) toast('Nothing changed');
  else toast(`${changes.length} price change${changes.length === 1 ? '' : 's'} added to the proposal (${total} in total) — simulate and publish to apply.`);
}

// ---- Behaviour ----

export function bind(root, rerender) {
  const chSel = root.querySelector('#cg-ch');
  if (chSel) chSel.onchange = () => { ui.channelId = chSel.value; ui.selectedIds = null; ui.filterQuery = ''; ui.filterOpen = false; rerender(); };
  root.querySelectorAll('[data-cg-exp]').forEach(b => b.onclick = () => { const id = b.dataset.cgExp; ui.expanded[id] = !ui.expanded[id]; rerender(); });

  const toggle = root.querySelector('#cg-toggle');
  if (toggle) toggle.onclick = () => {
    ui.filterOpen = !ui.filterOpen;
    ui.filterScroll = 0;
    rerender();
    if (ui.filterOpen) document.getElementById('cg-search')?.focus();
  };

  const bindFilterOpts = () => root.querySelectorAll('[data-cg-sel]').forEach(cb => cb.onchange = () => {
    ui.filterScroll = document.getElementById('cg-list')?.scrollTop ?? 0;
    const id = cb.dataset.cgSel;
    if (cb.checked) ui.selectedIds.add(id); else ui.selectedIds.delete(id);
    rerender();
  });
  bindFilterOpts();
  const list = root.querySelector('#cg-list');
  if (list) list.scrollTop = ui.filterScroll;

  const search = root.querySelector('#cg-search');
  if (search) search.oninput = () => {
    ui.filterQuery = search.value;
    ui.filterScroll = 0;
    const s = store.get();
    const q = ui.filterQuery.toLowerCase();
    const allClients = s.accounts.filter(a => a.channelId === ui.channelId);
    const filtered = q ? allClients.filter(a => a.name.toLowerCase().includes(q) || (a.zone || '').toLowerCase().includes(q)) : allClients;
    const listEl = root.querySelector('#cg-list');
    if (listEl) {
      listEl.innerHTML = filtered.map(a =>
        `<label class="multi-opt"><input type="checkbox" data-cg-sel="${esc(a.id)}" ${ui.selectedIds.has(a.id) ? 'checked' : ''}>
          <span class="grow">${esc(a.name)}</span><span class="small muted">${esc(a.zone ?? '—')}</span></label>`).join('');
      listEl.scrollTop = 0;
      bindFilterOpts();
    }
  };
  const allCb = root.querySelector('#cg-all');
  if (allCb) allCb.onchange = () => {
    const all = store.get().accounts.filter(a => a.channelId === ui.channelId);
    ui.selectedIds = allCb.checked ? new Set(all.map(a => a.id)) : new Set();
    rerender();
  };
  root.querySelectorAll('[data-cg]').forEach(el => {
    const [accId, code, i, field] = el.dataset.cg.split('|');
    const a = byId(store.get().accounts, accId);
    if (!a) return;
    el.oninput = () => {
      if (field === 'perKg' && el.value.startsWith('-')) el.value = el.value.replace(/-/g, '');
      editRows(a, code)[+i][field] = el.value;
      // Totals follow every keystroke without redrawing the field being typed into.
      const prem = root.querySelector(`#tp-${CSS.escape(accId)}`);
      if (prem && PREMIUM_COLS.some(c => c.code === code)) prem.innerHTML = totalCell(store.get(), a);
      const disc = root.querySelector(`#td-${CSS.escape(accId)}`);
      if (disc && DISCOUNT_COLS.some(c => c.code === code)) disc.innerHTML = discountCell(a);
    };
    // Leave the field showing centavos, the way every other amount in the app reads.
    if (field === 'perKg') el.onblur = () => {
      const v = toCentavos(el.value);
      el.value = v == null || v < 0 ? '' : toInput(v);
      editRows(a, code)[+i].perKg = el.value;
    };
  });
  const save = root.querySelector('#cg-save');
  if (save) save.onclick = () => saveAll(rerender);
}
