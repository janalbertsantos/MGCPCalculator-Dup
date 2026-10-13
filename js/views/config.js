// Configuration — manager. Users, channels, products, price watch zones and the clients list.
// Every save goes through store.commit, so configuration changes are logged like price changes.

import * as store from '../store.js';
import { fmt, toCentavos, toInput } from '../money.js';
import { esc, toast, options, download, preserveFocus } from '../ui.js';
import { parseCsv, toCsv, rowsToAccounts, accountsToRows, templateRows, newAccount } from '../csv.js';
import { channelLabel, skuLabel } from '../pricing.js';
import { configTabs } from '../router.js';
import { PARTS, LEVELS, ACCESS_ROLES, ROLE_LABEL, roleLevel, level as userLevel } from '../access.js';
import { FIELDS, labelFor, inputValue, displayValue, parseValue, usableKg } from '../clientterms.js';

const ROLES = ['seller', 'accounting', 'manager', 'admin', 'messenger', 'viewer'];
const ui = { tab: 'users', users: null, base: null, userErr: '', preview: null, mode: 'merge', fileName: '', clientQuery: '', editClient: null, terms: {}, basic: {}, clientErr: '', channels: null, chanBase: null, chanErr: '',
  skus: null, skuBase: null, skuErr: '', zones: null, zoneBase: null, zoneErr: '',
  brands: null, brandBase: null, brandErr: '', inl: {}, inlErr: '', cp: {}, cpErr: '', accUser: '' };

export function render(root, ctx) {
  const { state: s } = ctx;
  const base = JSON.stringify(s.users);
  if (!ui.users || ui.base !== base) { ui.users = JSON.parse(base); ui.base = base; }
  const chanBase = JSON.stringify(s.channels);
  if (!ui.channels || ui.chanBase !== chanBase) { ui.channels = JSON.parse(chanBase); ui.chanBase = chanBase; }
  const skuBase = JSON.stringify(s.skus);
  if (!ui.skus || ui.skuBase !== skuBase) { ui.skus = JSON.parse(skuBase); ui.skuBase = skuBase; }
  const zoneBase = JSON.stringify(s.zones);
  if (!ui.zones || ui.zoneBase !== zoneBase) { ui.zones = s.zones.map(z => ({ name: z, from: z })); ui.zoneBase = zoneBase; }
  const tabs = configTabs(s);
  const want = ctx.route?.query?.tab;
  if (want && tabs.some(([k]) => k === want)) ui.tab = want;
  if (!ui.brands || ui.brandBase !== JSON.stringify(s.trackedBrands)) { ui.brands = JSON.parse(JSON.stringify(s.trackedBrands)); ui.brandBase = JSON.stringify(s.trackedBrands); }
  const body = {
    users: () => usersHtml(s, ctx.user), channels: () => channelsHtml(s), products: () => productsHtml(s),
    zones: () => zonesHtml(s), competitors: () => competitorsHtml(s), clients: () => clientsHtml(s),
  };
  preserveFocus(root, () => {
    root.innerHTML = `<section class="page wide">
      <div class="page-head"><div><h1>Configuration · ${esc((tabs.find(([k]) => k === ui.tab) || tabs[0])[1].replace(/ \(\d+\)$/, ''))}</h1></div></div>
      ${(body[ui.tab] || body.users)()}
    </section>`;
  });
  bind(root, ctx);
}

// ---------------- Users ----------------

function usersHtml(s, me) {
  return `<div class="card">
    <div class="card-head"><div><h2>Users and roles</h2>
</div>
      <div class="row"><button type="button" id="u-add" class="small">Add user</button>
        <button type="button" id="u-discard" class="small">Discard changes</button>
        <button type="button" id="u-save" class="primary small">Save users</button></div></div>
    ${ui.userErr ? `<div class="banner red" role="alert">${esc(ui.userErr)}</div>` : ''}
    <div class="table-wrap"><table class="matrix">
      <thead><tr><th>Name</th><th>Role</th><th>Price lists</th><th class="center">May draft</th><th class="center">May approve</th><th></th></tr></thead>
      <tbody>${ui.users.map((u, i) => `<tr>
        <td style="min-width:220px"><input type="text" data-u="${i}" data-f="name" value="${esc(u.name)}" aria-label="Name"><div class="small muted">${esc(u.id)}</div></td>
        <td style="min-width:130px"><select data-u="${i}" data-f="role" aria-label="Role">${options(ROLES.map(r => ({ id: r, label: r[0].toUpperCase() + r.slice(1) })), u.role)}</select></td>
        <td>${u.role === 'manager' || u.role === 'admin' || u.role === 'accounting' ? '<span class="pill blue">All price lists</span>'
          : u.role === 'messenger' ? '<span class="small muted">None — messengers see no MGC prices</span>'
          : `<div class="checks">${s.channels.map(c => `<label class="check"><input type="checkbox" data-u="${i}" data-ch="${esc(c.id)}" ${u.channels.includes(c.id) ? 'checked' : ''}> ${esc(c.label)}</label>`).join('')}</div>`}</td>
        <td class="center"><input type="checkbox" data-u="${i}" data-f="canDraft" ${u.canDraft ? 'checked' : ''} ${u.role === 'manager' || u.role === 'admin' ? '' : 'disabled'} aria-label="May draft"></td>
        <td class="center"><input type="checkbox" data-u="${i}" data-f="canApprove" ${u.canApprove ? 'checked' : ''} ${u.role === 'manager' || u.role === 'admin' ? '' : 'disabled'} aria-label="May approve"></td>
        <td><button type="button" class="small" data-u-del="${i}" ${u.id === me.id ? 'disabled title="You are acting as this user"' : ''}>Remove</button></td></tr>`).join('')}
      </tbody></table></div></div>
    ${accessHtml(s, me)}`;
}

// ---- Price room access: roles × parts, and per-user overrides ----
// Each change saves at once and is logged. Only an admin can change access; everyone else sees it read-only.
function accessHtml(s, me) {
  const ro = me.role === 'admin' ? '' : 'disabled';
  const groups = [...new Set(PARTS.map(p => p.group))];
  const lvlOpts = (cur, extra = '') => `${extra}${LEVELS.map((l, i) => `<option value="${i}"${String(cur) === String(i) ? ' selected' : ''}>${l}</option>`).join('')}`;
  const people = s.users.filter(u => u.role !== 'messenger');
  const who = people.find(u => u.id === ui.accUser) || null;
  return `<div class="card" style="margin-top:12px">
    <div class="card-head"><div><h2>Price room access</h2>
      <p class="small muted">None hides a part, View reads it, Edit changes it, Approve signs off or decides.${ro ? ' Only an Admin can change this.' : ''}</p></div>
      <div class="row"><button type="button" id="acc-reset" class="small" ${ro}>Reset roles to defaults</button></div></div>
    <div class="table-wrap fit"><table class="matrix access">
      <thead><tr><th>Part</th>${ACCESS_ROLES.map(r => `<th class="center">${esc(ROLE_LABEL[r])}</th>`).join('')}</tr></thead>
      <tbody>${groups.map(g => `<tr class="grp-row"><th colspan="${ACCESS_ROLES.length + 1}">${esc(g)}</th></tr>
        ${PARTS.filter(p => p.group === g).map(p => `<tr><th scope="row">${esc(p.label)}</th>${ACCESS_ROLES.map(r => {
          const v = roleLevel(s, r, p.id);
          return `<td class="center acc-${v}"><select data-acc-role="${r}|${p.id}" aria-label="${esc(ROLE_LABEL[r])}: ${esc(p.label)}" ${ro}>${lvlOpts(v)}</select></td>`;
        }).join('')}</tr>`).join('')}`).join('')}</tbody></table></div>
    <h2 class="sub-h">Override for one person</h2>
    <div class="row tight"><label class="field inline"><span>User</span><select id="acc-user"><option value="">Choose a user</option>${people.map(u => `<option value="${esc(u.id)}"${u.id === ui.accUser ? ' selected' : ''}>${esc(u.name)} — ${esc(ROLE_LABEL[u.role] || u.role)}</option>`).join('')}</select></label>
      ${who && who.access && Object.keys(who.access).length ? `<button type="button" id="acc-user-clear" class="small" ${ro}>Remove ${Object.keys(who.access).length} override${Object.keys(who.access).length === 1 ? '' : 's'}</button>` : ''}</div>
    ${who ? `<div class="table-wrap fit"><table class="matrix access"><thead><tr><th>Part</th><th class="center">${esc(who.name)}</th><th class="center">Role default</th></tr></thead>
      <tbody>${PARTS.map(p => {
        const own = who.access?.[p.id];
        const base = roleLevel(s, who.role, p.id);
        return `<tr class="${own !== undefined ? 'edited' : ''}"><th scope="row">${esc(p.label)}</th>
          <td class="center"><select data-acc-user="${esc(who.id)}|${p.id}" aria-label="${esc(who.name)}: ${esc(p.label)}" ${ro}>${lvlOpts(own ?? '', `<option value=""${own === undefined ? ' selected' : ''}>Same as role (${LEVELS[base]})</option>`)}</select></td>
          <td class="center muted">${LEVELS[base]}</td></tr>`;
      }).join('')}</tbody></table></div>` : ''}
  </div>`;
}

async function setAccess(kind, id, part, value) {
  const s = store.get();
  if (kind === 'role') {
    const before = roleLevel(s, id, part);
    if (before === value) return;
    await store.commit({
      action: 'CONFIG_CHANGED', entity: 'access', entityId: id, field: part, before: LEVELS[before], after: { summary: `${ROLE_LABEL[id]}: ${PARTS.find(p => p.id === part).label} → ${LEVELS[value]}` },
    }, d => { d.accessRoles ||= {}; (d.accessRoles[id] ||= {})[part] = value; });
  } else {
    const u = s.users.find(x => x.id === id);
    const before = u.access?.[part];
    if (before === value) return;
    await store.commit({
      action: 'CONFIG_CHANGED', entity: 'access', entityId: id, field: part, before: before === undefined ? 'role default' : LEVELS[before],
      after: { summary: `${u.name}: ${PARTS.find(p => p.id === part).label} → ${value === undefined ? 'role default' : LEVELS[value]}` },
    }, d => {
      const x = d.users.find(y => y.id === id);
      x.access ||= {};
      if (value === undefined) delete x.access[part]; else x.access[part] = value;
      if (!Object.keys(x.access).length) delete x.access;
    });
  }
  toast('Access saved');
}

async function saveUsers(me) {
  const s = store.get();
  ui.userErr = '';
  const users = ui.users.map(u => ({
    ...u, name: u.name.trim(),
    channels: (u.role === 'manager' || u.role === 'admin' || u.role === 'accounting') ? ['*'] : u.role === 'messenger' ? [] : u.channels.filter(c => c !== '*'),
    canDraft: (u.role === 'manager' || u.role === 'admin') && !!u.canDraft, canApprove: (u.role === 'manager' || u.role === 'admin') && !!u.canApprove,
  }));
  const blankName = users.find(u => !u.name);
  if (blankName) return (ui.userErr = `User ${blankName.id} needs a name`);
  if (users.filter(u => u.role === 'manager' || u.role === 'admin').length < 2) return (ui.userErr = 'Keep at least two managers or admins — approval needs a verifier who is not the drafter');
  const noList = users.find(u => (u.role === 'seller' || u.role === 'viewer') && !u.channels.length);
  if (noList) return (ui.userErr = `${noList.name} needs at least one price list`);
  const meAfter = users.find(u => u.id === me.id);
  if (!meAfter || (meAfter.role !== 'manager' && meAfter.role !== 'admin')) return (ui.userErr = 'You are acting as this manager — switch to another manager before changing your own role');

  const summary = [];
  for (const u of users) {
    const old = s.users.find(x => x.id === u.id);
    if (!old) { summary.push(`added ${u.name} (${u.role})`); continue; }
    const diffs = [];
    if (old.name !== u.name) diffs.push(`name ${old.name} → ${u.name}`);
    if (old.role !== u.role) diffs.push(`role ${old.role} → ${u.role}`);
    if (JSON.stringify(old.channels) !== JSON.stringify(u.channels)) diffs.push(`price lists ${old.channels.join('/') || 'none'} → ${u.channels.join('/') || 'none'}`);
    if (old.canDraft !== u.canDraft) diffs.push(`may draft ${u.canDraft ? 'on' : 'off'}`);
    if (old.canApprove !== u.canApprove) diffs.push(`may approve ${u.canApprove ? 'on' : 'off'}`);
    if (diffs.length) summary.push(`${u.name}: ${diffs.join(', ')}`);
  }
  for (const old of s.users) if (!users.some(u => u.id === old.id)) summary.push(`removed ${old.name}`);
  if (!summary.length) { toast('No changes to save'); return; }

  await store.commit({
    action: 'CONFIG_CHANGED', entity: 'users', entityId: 'users', field: 'users',
    before: s.users, after: { summary: summary.join('; '), users },
  }, d => { d.users = users; });
  ui.users = null;
  toast('Users saved');
}

// ---------------- Channels ----------------
// The order of this list is the order every channel list in the app uses.

const channelId = label => (label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'CHANNEL').slice(0, 20);

// "3|-1" — move the row at index 3 one place up.
function move(list, spec) {
  const [i, step] = spec.split('|').map(Number);
  const to = i + step;
  if (to < 0 || to >= list.length) return;
  [list[i], list[to]] = [list[to], list[i]];
}

function channelsHtml(s) {
  const usage = id => ({
    clients: s.accounts.filter(a => a.channelId === id).length,
    products: s.marginRules.filter(r => r.channelId === id && r.effectiveTo == null).length,
  });
  return `<div class="card">
    <div class="card-head"><div><h2>Channels and price lists</h2>
</div>
      <div class="row"><button type="button" id="ch-add" class="small">Add channel</button>
        <button type="button" id="ch-discard" class="small">Discard changes</button>
        <button type="button" id="ch-save" class="primary small">Save channels</button></div></div>
    ${ui.chanErr ? `<div class="banner red" role="alert">${esc(ui.chanErr)}</div>` : ''}
    <div class="table-wrap"><table class="matrix">
      <thead><tr><th class="num">#</th><th>Name</th><th>Audience</th><th>ID</th><th class="num">Clients</th><th class="num">Priced products</th><th class="center">Move</th><th></th></tr></thead>
      <tbody>${ui.channels.map((c, i) => {
        const u = c._new ? { clients: 0, products: 0 } : usage(c.id);
        const locked = u.clients || u.products;
        return `<tr>
          <td class="num">${i + 1}</td>
          <td><input type="text" data-ch="${i}" data-f="label" value="${esc(c.label)}" aria-label="Channel name"></td>
          <td><input type="text" data-ch="${i}" data-f="audience" value="${esc(c.audience ?? '')}" aria-label="Audience"></td>
          <td class="small muted">${c._new ? '<i>set on save</i>' : esc(c.id)}</td>
          <td class="num">${u.clients}</td>
          <td class="num">${u.products}</td>
          <td class="center nowrap"><button type="button" class="icon small" data-ch-move="${i}|-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button><button type="button" class="icon small" data-ch-move="${i}|1" ${i === ui.channels.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button></td>
          <td><button type="button" class="small" data-ch-del="${i}" ${locked ? `disabled title="${u.clients} clients, ${u.products} priced products"` : ''}>Remove</button></td>
        </tr>`;
      }).join('')}</tbody></table></div>
    <p class="small muted">A channel can only be removed once it has no clients and no priced products.</p></div>
  ${channelProductsHtml(s)}`;
}

// ---- Which products each channel sells ----
// A product is "in" a channel while it has an open margin rule there. Existing margins are price levers and
// stay with the MPL calculator; a product added here needs a starting margin.
const sellable = s => s.skus.filter(k => k.active && (!k.hasVariants || !s.skus.some(v => v.parentId === k.id && v.active)));
const cpKey = (ch, sku) => `${ch}|${sku}`;
const cpPriced = (s, ch, sku) => s.marginRules.find(r => r.channelId === ch && r.skuId === sku && r.effectiveTo == null);
const cpOn = (s, ch, sku) => ui.cp[cpKey(ch, sku)]?.on ?? !!cpPriced(s, ch, sku);

function channelProductsHtml(s) {
  const skus = sellable(s);
  const edits = Object.keys(ui.cp).length;
  return `<div class="card" style="margin-top:16px">
    <div class="card-head"><div><h2>Products sold in each channel</h2>
      <p class="small muted">Tick the products a channel sells. A newly ticked product needs a starting margin per kg; unticking removes it from that channel's price list.</p></div>
      <div class="row"><span class="small muted">${edits ? `${edits} change${edits === 1 ? '' : 's'}` : ''}</span>
        <button type="button" id="cp-discard" class="small" ${edits ? '' : 'disabled'}>Discard changes</button>
        <button type="button" id="cp-save" class="primary small" ${edits ? '' : 'disabled'}>Save products</button></div></div>
    ${ui.cpErr ? `<div class="banner red" role="alert">${esc(ui.cpErr)}</div>` : ''}
    <div class="table-wrap"><table class="matrix">
      <thead><tr><th>Product</th>${s.channels.map(c => `<th class="center">${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${skus.map(k => `<tr><th scope="row"><div class="mh">${esc(k.label)}</div><div class="small muted">${k.contentKg} kg</div></th>
        ${s.channels.map(c => {
          const rule = cpPriced(s, c.id, k.id);
          const on = cpOn(s, c.id, k.id);
          const draft = ui.cp[cpKey(c.id, k.id)];
          return `<td class="center ${draft ? 'edited' : ''}"><label class="check" style="justify-content:center"><input type="checkbox" data-cp="${esc(c.id)}|${esc(k.id)}" ${on ? 'checked' : ''} aria-label="${esc(k.label)} in ${esc(c.label)}"></label>
            ${on && rule ? `<div class="small muted">margin ${fmt(rule.perKg)}</div>` : ''}
            ${on && !rule ? `<input type="text" inputmode="decimal" class="mini" data-cpm="${esc(c.id)}|${esc(k.id)}" placeholder="₱/kg margin" value="${esc(draft?.margin ?? '')}" aria-label="Starting margin per kg" style="width:96px;text-align:right">` : ''}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table></div></div>`;
}

async function saveChannelProducts() {
  const s = store.get();
  ui.cpErr = '';
  const adds = [], drops = [], notes = [];
  for (const [key, d] of Object.entries(ui.cp)) {
    const [chId, skuId] = key.split('|');
    const rule = cpPriced(s, chId, skuId);
    const chL = channelLabel(s, chId), skL = skuLabel(s, skuId);
    if (d.on && !rule) {
      const margin = toCentavos(d.margin);
      if (margin == null || margin < 0) { ui.cpErr = `Enter a starting margin per kg for ${skL} in ${chL}, for example 30.00`; return; }
      adds.push({ chId, skuId, margin });
      notes.push(`${skL} added to ${chL} at margin ${fmt(margin)}/kg`);
    } else if (!d.on && rule) {
      drops.push({ chId, skuId });
      const clients = s.accounts.filter(a => a.channelId === chId && a.primarySkuId === skuId).length;
      notes.push(`${skL} removed from ${chL}${clients ? ` (${clients} clients have it as main product)` : ''}`);
    }
  }
  if (!notes.length) { ui.cp = {}; toast('No changes to save'); return; }
  const hit = drops.reduce((n, x) => n + s.accounts.filter(a => a.channelId === x.chId && a.primarySkuId === x.skuId).length, 0);
  if (hit && !confirm(`${hit} clients have a removed product as their main product and will have no price for it. Save anyway?`)) return;
  const now = new Date().toISOString();
  await store.commit({
    action: 'CONFIG_CHANGED', entity: 'channelProducts', entityId: 'channelProducts', field: 'marginRules',
    before: null, after: { summary: notes.join('; ') },
  }, d => {
    for (const x of drops) for (const r of d.marginRules) if (r.channelId === x.chId && r.skuId === x.skuId && r.effectiveTo == null) r.effectiveTo = now;
    for (const x of adds) d.marginRules.push({ id: store.uid('mr'), channelId: x.chId, skuId: x.skuId, perKg: x.margin, effectiveFrom: now, effectiveTo: null });
  });
  ui.cp = {};
  toast('Channel products saved');
}

async function saveChannels() {
  const s = store.get();
  ui.chanErr = '';
  const next = ui.channels.map(c => ({ ...c, label: c.label.trim(), audience: (c.audience ?? '').trim() }));
  if (!next.length) return (ui.chanErr = 'Keep at least one channel');
  const blank = next.find(c => !c.label);
  if (blank) return (ui.chanErr = 'Every channel needs a name');

  // New rows get their id from the name; existing ids never change, because the data references them.
  const taken = new Set(next.filter(c => !c._new).map(c => c.id));
  for (const c of next) {
    if (!c._new) continue;
    let id = channelId(c.label), n = 2;
    while (taken.has(id)) id = `${channelId(c.label)}_${n++}`;
    taken.add(id);
    c.id = id;
    delete c._new;
  }

  const beforeIds = s.channels.map(c => c.id);
  const afterIds = next.map(c => c.id);
  const summary = [];
  for (const c of next) {
    const old = s.channels.find(x => x.id === c.id);
    if (!old) { summary.push(`added ${c.label}`); continue; }
    if (old.label !== c.label) summary.push(`renamed ${old.label} → ${c.label}`);
    if ((old.audience ?? '') !== c.audience) summary.push(`${c.label} audience → ${c.audience || 'none'}`);
  }
  for (const id of beforeIds) if (!afterIds.includes(id)) summary.push(`removed ${s.channels.find(c => c.id === id).label}`);
  if (beforeIds.join() !== afterIds.filter(id => beforeIds.includes(id)).join()) summary.push(`order: ${next.map(c => c.label).join(' › ')}`);
  if (!summary.length) { toast('No changes to save'); return; }

  await store.commit({
    action: 'CONFIG_CHANGED', entity: 'channels', entityId: 'channels', field: 'channels',
    before: s.channels, after: { summary: summary.join('; '), channels: next },
  }, d => {
    const gone = beforeIds.filter(id => !afterIds.includes(id));
    d.channels = next;
    d.buffers = (d.buffers || []).filter(b => !gone.includes(b.channelId));
    for (const c of next) {
      if (d.buffers.some(b => b.channelId === c.id && b.effectiveTo == null)) continue;
      d.buffers.push({ id: store.uid('buf'), channelId: c.id, perKg: 0, effectiveFrom: new Date().toISOString(), effectiveTo: null });
    }
    for (const u of d.users) u.channels = u.channels.filter(ch => ch === '*' || !gone.includes(ch));
  });
  ui.channels = null;
  toast('Channels saved');
}

// ---------------- Products ----------------
// This order is the order products appear in every list and on every price list.

function productUsage(s, id) {
  return {
    priced: s.marginRules.filter(r => r.skuId === id && r.effectiveTo == null).length,
    clients: s.accounts.filter(a => a.primarySkuId === id).length,
    quotes: s.quotes.filter(q => q.skuId === id).length + s.competitorReadings.filter(r => r.skuId === id).length,
  };
}

function productsHtml(s) {
  const parents = ui.skus.filter(k => k.hasVariants);
  const variants = ui.skus.filter(k => k.parentId);
  const standalone = ui.skus.filter(k => !k.hasVariants && !k.parentId);

  function skuRow(k, i, indent) {
    const u = k._new ? { priced: 0, clients: 0, quotes: 0 } : productUsage(s, k.id);
    const locked = u.priced || u.clients || u.quotes;
    const isParent = k.hasVariants;
    const isVariant = !!k.parentId;
    return `<tr class="${isVariant ? 'variant-row' : ''}">
      <td class="num">${i + 1}</td>
      <td style="${indent ? 'padding-left:28px' : ''}">
        <input type="text" data-sk="${i}" data-f="label" value="${esc(k.label)}" aria-label="Product name">
        ${isParent ? '<span class="pill blue small">Parent</span>' : ''}
        ${isVariant ? '<span class="pill grey small">Variant</span>' : ''}</td>
      <td>${isParent ? '<span class="muted small">—</span>' : `<input type="number" min="0.1" step="0.1" data-sk="${i}" data-f="contentKg" value="${esc(k.contentKg ?? '')}" aria-label="Content kg">`}</td>
      <td class="center"><input type="checkbox" data-sk="${i}" data-f="active" ${k.active ? 'checked' : ''} aria-label="Sold"></td>
      <td class="center"><input type="checkbox" data-sk="${i}" data-f="hasVariants" ${k.hasVariants ? 'checked' : ''} ${isVariant ? 'disabled' : ''} aria-label="Has variants"></td>
      <td class="small muted">${k._new ? '<i>set on save</i>' : esc(k.id)}</td>
      <td class="num">${u.priced} ch</td>
      <td class="num">${u.clients}</td>
      <td class="center nowrap"><button type="button" class="icon small" data-sk-move="${i}|-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button><button type="button" class="icon small" data-sk-move="${i}|1" ${i === ui.skus.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button></td>
      <td class="nowrap">
        ${isParent ? `<button type="button" class="small" data-sk-addvar="${i}">+ Variant</button>` : ''}
        <button type="button" class="small" data-sk-del="${i}" ${locked ? `disabled title="Priced on ${u.priced} channels, ${u.clients} clients, ${u.quotes} quotes or readings"` : ''}>Remove</button></td>
    </tr>`;
  }

  const rows = [];
  for (let i = 0; i < ui.skus.length; i++) {
    const k = ui.skus[i];
    if (k.parentId) continue;
    rows.push(skuRow(k, i, false));
    if (k.hasVariants) {
      for (let j = 0; j < ui.skus.length; j++) {
        if (ui.skus[j].parentId === k.id) rows.push(skuRow(ui.skus[j], j, true));
      }
    }
  }

  return `<div class="card">
    <div class="card-head"><h2>Products</h2>
      <div class="row"><button type="button" id="sk-add" class="small">Add product</button>
        <button type="button" id="sk-discard" class="small">Discard changes</button>
        <button type="button" id="sk-save" class="primary small">Save products</button></div></div>
    ${ui.skuErr ? `<div class="banner red" role="alert">${esc(ui.skuErr)}</div>` : ''}
    <div class="table-wrap"><table class="matrix">
      <thead><tr><th class="num">#</th><th>Name</th><th class="num">Content kg</th><th class="center">Sold</th><th class="center">Variant</th><th>ID</th><th class="num">Priced</th><th class="num">Clients</th><th class="center">Move</th><th></th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>
    <p class="small muted">Tick <b>Variant</b> to group child variants under a parent product. Variants drive internal pricing; only the parent name appears on client price lists. Untick <b>Sold</b> to hide a product without deleting it.</p></div>`;
}

async function saveProducts() {
  const s = store.get();
  ui.skuErr = '';
  const next = ui.skus.map(k => {
    const out = { ...k, label: k.label.trim(), active: !!k.active };
    if (k.hasVariants) { out.contentKg = null; out.hasVariants = true; }
    else { out.contentKg = Number(k.contentKg); delete out.hasVariants; }
    if (k.parentId) out.parentId = k.parentId;
    else delete out.parentId;
    return out;
  });
  if (!next.length) return (ui.skuErr = 'Keep at least one product');
  const blank = next.find(k => !k.label);
  if (blank) return (ui.skuErr = 'Every product needs a name');
  const badKg = next.find(k => !k.hasVariants && (!Number.isFinite(k.contentKg) || k.contentKg <= 0));
  if (badKg) return (ui.skuErr = `${badKg.label} needs a content in kilograms`);

  const taken = new Set(next.filter(k => !k._new).map(k => k.id));
  for (const k of next) {
    if (!k._new) continue;
    let id = channelId(k.label), n = 2;
    while (taken.has(id)) id = `${channelId(k.label)}_${n++}`;
    taken.add(id);
    k.id = id;
    delete k._new;
  }

  const summary = [];
  for (const k of next) {
    const old = s.skus.find(x => x.id === k.id);
    if (!old) { summary.push(`added ${k.label}`); continue; }
    if (old.label !== k.label) summary.push(`renamed ${old.label} → ${k.label}`);
    if (old.contentKg !== k.contentKg) summary.push(`${k.label} content ${old.contentKg} → ${k.contentKg} kg`);
    if (old.active !== k.active) summary.push(`${k.label} ${k.active ? 'sold again' : 'no longer sold'}`);
  }
  for (const old of s.skus) if (!next.some(k => k.id === old.id)) summary.push(`removed ${old.label}`);
  if (s.skus.map(k => k.id).join() !== next.map(k => k.id).filter(id => s.skus.some(x => x.id === id)).join()) summary.push(`order: ${next.map(k => k.label).join(' › ')}`);
  if (!summary.length) { toast('No changes to save'); return; }

  await store.commit({
    action: 'CONFIG_CHANGED', entity: 'skus', entityId: 'skus', field: 'skus',
    before: s.skus, after: { summary: summary.join('; '), skus: next },
  }, d => { d.skus = next; });
  ui.skus = null;
  toast('Products saved');
}

// ---------------- Price watch zones ----------------

function zoneUsage(s, name) {
  return {
    readings: s.competitorReadings.filter(r => r.zone === name).length,
    clients: s.accounts.filter(a => a.zone && (a.zone === name || a.zone.startsWith(name))).length,
  };
}

function zonesHtml(s) {
  return `<div class="card">
    <div class="card-head"><h2>Price watch zones</h2>
      <div class="row"><button type="button" id="z-add" class="small">Add zone</button>
        <button type="button" id="z-discard" class="small">Discard changes</button>
        <button type="button" id="z-save" class="primary small">Save zones</button></div></div>
    ${ui.zoneErr ? `<div class="banner red" role="alert">${esc(ui.zoneErr)}</div>` : ''}
    <div class="table-wrap"><table class="matrix">
      <thead><tr><th class="num">#</th><th>Zone</th><th class="num">Readings</th><th class="num">Clients</th><th class="center">Move</th><th></th></tr></thead>
      <tbody>${ui.zones.map((z, i) => {
        const u = z.from ? zoneUsage(s, z.from) : { readings: 0, clients: 0 };
        return `<tr>
          <td class="num">${i + 1}</td>
          <td><input type="text" data-z="${i}" value="${esc(z.name)}" aria-label="Zone name"></td>
          <td class="num">${u.readings}</td>
          <td class="num">${u.clients}</td>
          <td class="center nowrap"><button type="button" class="icon small" data-z-move="${i}|-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button><button type="button" class="icon small" data-z-move="${i}|1" ${i === ui.zones.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button></td>
          <td><button type="button" class="small" data-z-del="${i}" ${u.readings || u.clients ? `disabled title="${u.readings} readings, ${u.clients} clients"` : ''}>Remove</button></td>
        </tr>`;
      }).join('')}</tbody></table></div>
    <p class="small muted">Zones drive the messenger's weekly checklist, the competitor readings and the "no reading this week" approvals. Renaming one carries its readings and clients across.</p></div>`;
}

async function saveZones() {
  const s = store.get();
  ui.zoneErr = '';
  const next = ui.zones.map(z => ({ ...z, name: z.name.trim() }));
  if (!next.length) return (ui.zoneErr = 'Keep at least one zone');
  if (next.some(z => !z.name)) return (ui.zoneErr = 'Every zone needs a name');
  const names = next.map(z => z.name.toLowerCase());
  const dupe = names.find((n, i) => names.indexOf(n) !== i);
  if (dupe) return (ui.zoneErr = `Two zones are both called "${dupe}"`);

  const renames = next.filter(z => z.from && z.from !== z.name);
  const summary = [
    ...next.filter(z => !z.from).map(z => `added ${z.name}`),
    ...renames.map(z => `renamed ${z.from} → ${z.name}`),
    ...s.zones.filter(z => !next.some(n => n.from === z)).map(z => `removed ${z}`),
  ];
  const order = next.map(z => z.name);
  if (s.zones.join() !== order.filter(n => s.zones.includes(n)).join()) summary.push(`order: ${order.join(' › ')}`);
  if (!summary.length) { toast('No changes to save'); return; }

  await store.commit({
    action: 'CONFIG_CHANGED', entity: 'zones', entityId: 'zones', field: 'zones',
    before: s.zones, after: { summary: summary.join('; '), zones: order },
  }, d => {
    d.zones = order;
    for (const { from, name } of renames) {
      for (const r of d.competitorReadings) if (r.zone === from) r.zone = name;
      for (const a of d.accounts) {
        if (a.zone === from) a.zone = name;
        else if (a.zone && a.zone.startsWith(from)) a.zone = name + a.zone.slice(from.length);
      }
    }
  });
  ui.zones = null;
  toast('Zones saved');
}

// ---------------- Competitors ----------------

function competitorsHtml(s) {
  return `<div class="card">
    <div class="card-head"><h2>Tracked competitor brands</h2>
      <div class="row"><button type="button" id="br-add" class="small">Add brand</button>
        <button type="button" id="br-discard" class="small">Discard changes</button>
        <button type="button" id="br-save" class="primary small">Save brands</button></div></div>
    ${ui.brandErr ? `<div class="banner red" role="alert">${esc(ui.brandErr)}</div>` : ''}
    <div class="table-wrap"><table class="matrix">
      <thead><tr><th class="num">#</th><th>Brand name</th><th>Zone</th><th class="num">Readings</th><th class="num">Clients</th><th></th></tr></thead>
      <tbody>${ui.brands.map((b, i) => {
        const name = typeof b === 'string' ? b : b.name;
        const zone = typeof b === 'string' ? '' : (b.zone || '');
        const readings = s.competitorReadings.filter(r => r.brand === name).length;
        const clients = s.accounts.filter(a => a.competitorBrand === name).length;
        return `<tr>
          <td class="num">${i + 1}</td>
          <td><input type="text" data-br="${i}" data-bf="name" value="${esc(name)}" aria-label="Brand name"></td>
          <td><input type="text" data-br="${i}" data-bf="zone" value="${esc(zone)}" list="cfg-zones-br" aria-label="Zone" style="max-width:160px"></td>
          <td class="num">${readings}</td>
          <td class="num">${clients}</td>
          <td><button type="button" class="small" data-br-del="${i}" ${readings || clients ? `disabled title="${readings} readings, ${clients} clients"` : ''}>Remove</button></td>
        </tr>`;
      }).join('')}</tbody></table></div>
    <datalist id="cfg-zones-br">${s.zones.map(z => `<option value="${esc(z)}"></option>`).join('')}</datalist>
    <p class="small muted">Each competitor entry includes its zone. Readings in the price watch use the zone from here.</p></div>`;
}

async function saveBrands() {
  const s = store.get();
  ui.brandErr = '';
  const next = ui.brands.map(b => {
    const name = (typeof b === 'string' ? b : b.name || '').trim();
    const zone = (typeof b === 'string' ? '' : b.zone || '').trim();
    return { name, zone };
  }).filter(b => b.name);
  if (!next.length) return (ui.brandErr = 'Keep at least one brand');
  const lc = next.map(b => b.name.toLowerCase());
  const dupe = lc.find((n, i) => lc.indexOf(n) !== i);
  if (dupe) return (ui.brandErr = `Two brands are both called "${dupe}"`);

  const oldNames = s.trackedBrands.map(b => typeof b === 'string' ? b : b.name);
  const newNames = next.map(b => b.name);
  const summary = [];
  for (const b of newNames) if (!oldNames.includes(b)) summary.push(`added ${b}`);
  for (const b of oldNames) if (!newNames.includes(b)) summary.push(`removed ${b}`);
  const renamed = [];
  for (let i = 0; i < Math.min(oldNames.length, newNames.length); i++) {
    if (oldNames[i] !== newNames[i] && !oldNames.includes(newNames[i]) && !newNames.includes(oldNames[i])) {
      renamed.push({ from: oldNames[i], to: newNames[i] });
      summary.push(`renamed ${oldNames[i]} → ${newNames[i]}`);
    }
  }
  for (const b of next) {
    const old = s.trackedBrands.find(x => (typeof x === 'string' ? x : x.name) === b.name);
    if (old && typeof old !== 'string' && old.zone !== b.zone) summary.push(`${b.name} zone: ${old.zone || '—'} → ${b.zone || '—'}`);
  }
  if (!summary.length) { toast('No changes to save'); return; }

  await store.commit({
    action: 'CONFIG_CHANGED', entity: 'competitors', entityId: 'competitors', field: 'trackedBrands',
    before: s.trackedBrands, after: { summary: summary.join('; '), trackedBrands: next },
  }, d => {
    d.trackedBrands = next;
    for (const { from, to } of renamed) {
      for (const r of d.competitorReadings) if (r.brand === from) r.brand = to;
      for (const a of d.accounts) if (a.competitorBrand === from) a.competitorBrand = to;
    }
  });
  ui.brands = null;
  toast('Brands saved');
}

// ---------------- Clients ----------------

function clientsHtml(s) {
  const q = ui.clientQuery.trim().toLowerCase();
  const list = s.accounts.filter(a => !q || a.name.toLowerCase().includes(q) || (a.clientCode || '').toLowerCase().includes(q));
  const compOut = (xs, cat) => (xs || []).map(x => {
    const c = s[cat].find(k => k.code === x.code);
    return `${c?.label ?? x.code}${x.perKg != null ? ` ${fmt(x.perKg)}` : ''}`;
  }).join(', ') || '—';

  return `<div class="card">
    <div class="card-head"><div><h2>Import clients from CSV</h2>
      <p class="small muted">Required columns: Name, Channel, Status. Every other column is optional; a column left out keeps the client's current value. Download the template for the full set of columns.</p></div>
      <div class="row"><button type="button" id="c-template" class="small">Download template</button><button type="button" id="c-export" class="small">Export clients CSV</button></div></div>
    <div class="row"><label class="btn primary small" for="c-file">Choose CSV file</label><input id="c-file" type="file" accept=".csv,.tsv,.txt,text/csv" hidden>
      <span class="small muted">${esc(ui.fileName || 'No file chosen')}</span></div>
    ${ui.preview ? previewHtml(s) : ''}
  </div>

  ${ui.editClient ? termsEditor(s) : ''}

  <div class="card" style="margin-top:16px">
    <div class="card-head"><h2>Clients (${s.accounts.length})</h2>
      <div class="row"><input id="c-q" type="search" placeholder="Filter by name or client ID" value="${esc(ui.clientQuery)}" style="max-width:240px" aria-label="Filter clients">
        <span class="small muted">${inlCount() ? `${inlCount()} client${inlCount() === 1 ? '' : 's'} edited` : 'Edit any cell, then save'}</span>
        <button type="button" id="ci-discard" class="small" ${inlCount() ? '' : 'disabled'}>Discard changes</button>
        <button type="button" id="ci-save" class="primary small" ${inlCount() ? '' : 'disabled'}>Save changes</button></div></div>
    ${ui.inlErr ? `<div class="banner red" role="alert">${esc(ui.inlErr)}</div>` : ''}
    <datalist id="cfg-zones-i">${s.zones.map(z => `<option value="${esc(z)}"></option>`).join('')}</datalist>
    <div class="table-wrap"><table class="matrix">
      <thead><tr><th>Client ID</th><th>Name</th><th>Channel</th><th>Status</th><th>Zone</th><th>Main product</th><th class="num">Avg monthly kg</th><th class="num">Credit days</th><th>Premiums</th><th>Discounts</th><th></th></tr></thead>
      <tbody>${list.map(a => `<tr class="${ui.inl[a.id] ? 'edited' : ''}"><td><input type="text" data-ci="${esc(a.id)}|clientCode" value="${esc(inlVal(a, 'clientCode'))}" aria-label="Client ID" placeholder="Client ID" style="width:110px"></td><td style="min-width:200px"><input type="text" data-ci="${esc(a.id)}|name" value="${esc(inlVal(a, 'name'))}" aria-label="Client name"><div class="small muted" title="System reference, cannot change">ref ${esc(a.id)}</div></td>
        <td><select data-ci="${esc(a.id)}|channelId" aria-label="Channel">${s.channels.map(c => `<option value="${esc(c.id)}"${c.id === inlVal(a, 'channelId') ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</select></td>
        <td><select data-ci="${esc(a.id)}|status" aria-label="Status">${['Active', 'Inactive'].map(v => `<option${v === inlVal(a, 'status') ? ' selected' : ''}>${v}</option>`).join('')}</select>${a.needsAttention ? ' <span class="pill amber">Attention</span>' : ''}</td>
        <td><input type="text" list="cfg-zones-i" data-ci="${esc(a.id)}|zone" value="${esc(inlVal(a, 'zone'))}" aria-label="Zone" style="min-width:110px"></td>
        <td><select data-ci="${esc(a.id)}|primarySkuId" aria-label="Main product"><option value=""></option>${s.skus.filter(k => k.active).map(k => `<option value="${esc(k.id)}"${k.id === inlVal(a, 'primarySkuId') ? ' selected' : ''}>${esc(k.label)}</option>`).join('')}</select></td>
        <td class="num"><input type="number" min="0" step="1" data-ci="${esc(a.id)}|avgMonthlyVolumeKg" value="${esc(inlVal(a, 'avgMonthlyVolumeKg'))}" aria-label="Avg monthly kg" style="width:100px;text-align:right"></td>
        <td class="num"><input type="number" min="0" step="1" data-ci="${esc(a.id)}|creditTermDays" value="${esc(inlVal(a, 'creditTermDays'))}" aria-label="Credit days" style="width:70px;text-align:right"></td>
        <td class="small">${esc(compOut(a.premiums, 'premiumComponents'))}</td>
        <td class="small">${esc(compOut(a.discounts, 'discountComponents'))}</td>
        <td><button type="button" class="small" data-c-edit="${esc(a.id)}">Edit</button></td></tr>`).join('') || '<tr><td colspan="11" class="muted">No clients match.</td></tr>'}
      </tbody></table></div></div>`;
}

// Inline edits in the clients table: drafts live in ui.inl until saved.
const INLINE = [['clientCode', 'Client ID'], ['name', 'Client name'], ['channelId', 'Channel'], ['status', 'Status'], ['zone', 'Zone'], ['primarySkuId', 'Main product'], ['avgMonthlyVolumeKg', 'Avg monthly volume'], ['creditTermDays', 'Credit term']];
const INT_KEYS = ['avgMonthlyVolumeKg', 'creditTermDays'];
const inlCount = () => Object.keys(ui.inl).length;
const inlVal = (a, k) => (ui.inl[a.id]?.[k] !== undefined ? ui.inl[a.id][k] : a[k] == null ? '' : String(a[k]));

async function saveInline() {
  const s = store.get();
  ui.inlErr = '';
  const patches = [], notes = [];
  for (const [id, draft] of Object.entries(ui.inl)) {
    const a = s.accounts.find(x => x.id === id);
    if (!a) continue;
    const patch = {}, parts = [];
    for (const [key, label] of INLINE) {
      if (draft[key] === undefined) continue;
      const raw = String(draft[key]).trim();
      let value = raw === '' ? null : raw;
      if (INT_KEYS.includes(key) && value != null) {
        value = Math.round(Number(value.replace(/[,\s]/g, '')));
        if (!Number.isFinite(value) || value < 0) { ui.inlErr = `${a.name}: ${label} must be a number of 0 or more`; return; }
      }
      if (key === 'name' && !value) { ui.inlErr = 'Every client needs a name'; return; }
      if ((key === 'channelId' || key === 'status') && !value) { ui.inlErr = `${a.name}: ${label} is required`; return; }
      if ((a[key] ?? null) === value) continue;
      patch[key] = value;
      parts.push(`${label} ${a[key] ?? 'none'} → ${value ?? 'none'}`);
    }
    if (parts.length) { patches.push({ id, patch }); notes.push(`${a.name}: ${parts.join('; ')}`); }
  }
  if (!patches.length) { ui.inl = {}; toast('Nothing changed'); return; }
  const codeOwner = new Map();
  for (const a of s.accounts) {
    const code = String(patches.find(p => p.id === a.id)?.patch.clientCode === undefined ? a.clientCode ?? '' : patches.find(p => p.id === a.id).patch.clientCode ?? '').trim().toLowerCase();
    if (!code) continue;
    if (codeOwner.has(code)) { ui.inlErr = `Client ID ${code.toUpperCase()} is used by both ${codeOwner.get(code)} and ${a.name}. Client IDs must be unique`; return; }
    codeOwner.set(code, a.name);
  }
  await store.commit({
    action: 'CLIENT_TERMS_SAVED', entity: 'account', entityId: patches.length === 1 ? patches[0].id : 'accounts', field: 'client',
    before: null,
    after: { count: patches.length, accountIds: patches.map(p => p.id), summary: notes.join(' | '), top: Object.fromEntries(patches.map(p => [p.id, p.patch])) },
  }, d => {
    for (const p of patches) Object.assign(d.accounts.find(x => x.id === p.id), p.patch);
  });
  ui.inl = {};
  toast(`${patches.length} client${patches.length === 1 ? '' : 's'} saved`);
}

// The basic client record, edited alongside the terms below it.
const BASIC = [
  { key: 'clientCode', label: 'Client ID', type: 'text' },
  { key: 'name', label: 'Client name', type: 'text' },
  { key: 'channelId', label: 'Channel', type: 'select', from: s => s.channels.map(c => [c.id, c.label]) },
  { key: 'status', label: 'Status', type: 'select', from: () => [['Active', 'Active'], ['Inactive', 'Inactive']] },
  { key: 'needsAttention', label: 'Needs attention', type: 'select', from: () => [['no', 'No'], ['yes', 'Yes']] },
  { key: 'zone', label: 'Zone', type: 'zone' },
  { key: 'primarySkuId', label: 'Main product', type: 'select', from: s => s.skus.filter(k => k.active).map(k => [k.id, k.label]) },
  { key: 'avgMonthlyVolumeKg', label: 'Avg monthly volume (kg)', type: 'int' },
  { key: 'creditTermDays', label: 'Credit term (days)', type: 'int' },
  { key: 'competitorBrand', label: 'Competitor brand', type: 'text' },
  { key: 'email', label: 'Email address', type: 'text' },
  { key: 'variantId', label: 'Product variant', type: 'select', from: s => {
    const out = [['', '— None —']];
    for (const k of s.skus) { if (k.parentId) out.push([k.id, `${k.label} (${s.skus.find(p => p.id === k.parentId)?.label ?? ''})`]); }
    return out;
  }},
];

const basicValue = (a, f) => {
  if (ui.basic[f.key] !== undefined) return ui.basic[f.key];
  if (f.key === 'needsAttention') return a.needsAttention ? 'yes' : 'no';
  return a[f.key] == null ? '' : String(a[f.key]);
};

// Client editor — the basic record, then the terms the pricing grid shows read-only.
function termsEditor(s) {
  const a = s.accounts.find(x => x.id === ui.editClient);
  if (!a) return '';
  const draft = ui.terms;
  return `<div class="card terms-editor" style="margin-top:16px">
    <div class="card-head"><div><h2>${esc(a.name)}</h2>
      <p class="small muted">${esc(a.id)} · fields marked <span class="pill amber">price lever</span> change the price as soon as they are saved.</p></div>
      <div class="row"><button type="button" id="ct-cancel" class="small">Cancel</button><button type="button" id="ct-save" class="primary small">Save client</button></div></div>
    ${ui.clientErr ? `<div class="banner red" role="alert">${esc(ui.clientErr)}</div>` : ''}
    <div class="section-title">Client details</div>
    <div class="prof-grid">
      ${BASIC.map(f => {
        const v = basicValue(a, f);
        const input = f.type === 'select'
          ? `<select data-cb="${f.key}">${f.key === 'primarySkuId' ? '<option value=""></option>' : ''}${f.from(s).map(([val, label]) => `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`
          : f.type === 'zone'
            ? `<input data-cb="zone" type="text" list="cfg-zones" value="${esc(v)}">`
            : `<input data-cb="${f.key}" type="${f.type === 'int' ? 'number' : 'text'}"${f.type === 'int' ? ' min="0" step="1"' : ''} value="${esc(v)}">`;
        return `<label class="prof-f"><span>${esc(f.label)}</span>${input}</label>`;
      }).join('')}
    </div>
    <datalist id="cfg-zones">${s.zones.map(z => `<option value="${esc(z)}"></option>`).join('')}</datalist>
    <div class="section-title">Client terms</div>
    <div class="prof-grid">
      ${FIELDS.map(f => {
        const label = `${esc(labelFor(f))}${f.lever ? ' <span class="pill amber">price lever</span>' : ''}`;
        if (f.type === 'computed') return `<label class="prof-f"><span>${label}</span><input value="${usableKg(a, draft).toLocaleString('en-PH')} kg" readonly aria-readonly="true"></label>`;
        const v = inputValue(a, f, draft);
        const input = f.type === 'select'
          ? `<select data-ct="${esc(f.key)}"><option value=""></option>${f.choices.map(c => `<option${c === v ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>`
          : `<input data-ct="${esc(f.key)}" type="${f.type === 'date' ? 'date' : 'text'}"${f.type === 'money' || f.type === 'int' ? ' inputmode="decimal"' : ''} value="${esc(v)}">`;
        return `<label class="prof-f"><span>${label}</span>${input}</label>`;
      }).join('')}
    </div></div>`;
}

async function saveTerms() {
  const s = store.get();
  const a = s.accounts.find(x => x.id === ui.editClient);
  if (!a) return;
  const top = {}, terms = {}, changed = [];
  ui.clientErr = '';

  // Basic record first, so a bad value stops the whole save.
  for (const f of BASIC) {
    if (ui.basic[f.key] === undefined) continue;
    const raw = String(ui.basic[f.key]).trim();
    let value;
    if (f.key === 'needsAttention') value = raw === 'yes';
    else if (f.type === 'int') { value = raw === '' ? null : Math.round(Number(raw.replace(/[,\s]/g, ''))); if (value != null && (!Number.isFinite(value) || value < 0)) { ui.clientErr = `${f.label} must be a number of 0 or more`; return; } }
    else value = raw === '' ? null : raw;
    if (f.key === 'name' && !value) { ui.clientErr = 'The client needs a name'; return; }
    if (f.key === 'clientCode' && value) {
      const clash = s.accounts.find(x => x.id !== a.id && (x.clientCode || '').toLowerCase() === value.toLowerCase());
      if (clash) { ui.clientErr = `Client ID ${value} is already used by ${clash.name}`; return; }
    }
    if ((f.key === 'channelId' || f.key === 'status') && !value) { ui.clientErr = `${f.label} is required`; return; }
    const before = a[f.key] ?? (f.key === 'needsAttention' ? false : null);
    if (before === value) continue;
    top[f.key] = value;
    const show = v => (v == null || v === '' ? 'none' : f.key === 'channelId' ? channelLabel(s, v) : f.key === 'primarySkuId' ? skuLabel(s, v) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v);
    changed.push(`${f.label} ${show(before)} → ${show(value)}`);
  }

  for (const [key, raw] of Object.entries(ui.terms)) {
    const f = FIELDS.find(x => x.key === key);
    if (!f || f.type === 'computed') continue;
    const value = parseValue(f, raw);
    const before = (f.top ? a[key] : a.profile?.[key]) ?? null;
    if (before === value) continue;
    (f.top ? top : terms)[key] = value;
    changed.push(`${f.label} ${displayValue(a, f)} → ${displayValue(a, f, { [key]: value })}`);
  }
  if (!changed.length) { toast('Nothing changed'); return; }
  await store.commit({
    action: 'CLIENT_TERMS_SAVED', entity: 'account', entityId: a.id, field: 'terms',
    before: { profile: a.profile ?? null },
    after: { count: 1, accountId: a.id, accountIds: [a.id], summary: `${a.name}: ${changed.join('; ')}`, top, terms },
  }, d => {
    const acc = d.accounts.find(x => x.id === a.id);
    Object.assign(acc, top);
    acc.profile = { ...(acc.profile || {}), ...terms };
  });
  ui.terms = {};
  ui.basic = {};
  toast('Client saved');
}

function previewHtml(s) {
  const p = ui.preview;
  if (p.fatal) return `<div class="banner red" role="alert" style="margin-top:12px">${esc(p.fatal)}</div>`;
  const valid = p.results.filter(r => r.action !== 'error');
  const adds = valid.filter(r => r.action === 'add').length;
  const replace = ui.mode === 'replace';
  const rows = [...p.results].sort((a, b) => (a.action === 'error') - (b.action === 'error') || a.rowNo - b.rowNo).slice(0, 300);
  return `<div class="preview">
    <div class="kpis">
      <div><span>Rows read</span><b>${p.rowCount}</b></div>
      <div><span>New clients</span><b>${replace ? valid.length : adds}</b></div>
      <div><span>Updates</span><b>${replace ? 0 : valid.length - adds}</b></div>
      <div><span>Skipped with errors</span><b class="${p.results.length - valid.length ? 'pos' : ''}">${p.results.length - valid.length}</b></div>
    </div>
    ${p.ignored.length ? `<p class="small muted">Ignored columns: ${esc(p.ignored.join(', '))}</p>` : ''}
    <div class="row" style="margin:8px 0">
      <label class="check"><input type="radio" name="c-mode" value="merge" ${replace ? '' : 'checked'}> Add new, update matching clients</label>
      <label class="check"><input type="radio" name="c-mode" value="replace" ${replace ? 'checked' : ''}> Replace the whole list (${s.accounts.length} current clients removed)</label>
    </div>
    <div class="table-wrap" style="max-height:360px"><table class="mini">
      <thead><tr><th>Row</th><th>Name</th><th>Channel</th><th>Status</th><th>Result</th><th>Notes</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td class="num">${r.rowNo}</td><td>${esc(r.name || '—')}</td><td>${esc(r.channelId ? channelLabel(s, r.channelId) : '—')}</td>
        <td>${esc(r.status ?? '—')}${r.patch.needsAttention ? ' <span class="pill amber">Attention</span>' : ''}</td>
        <td><span class="pill ${r.action === 'error' ? 'red' : r.action === 'add' || replace ? 'tiffany' : 'blue'}">${r.action === 'error' ? 'Skipped' : r.action === 'add' || replace ? 'New' : 'Update'}</span></td>
        <td class="small">${[...r.errors.map(e => `<span class="pos">${esc(e)}</span>`), ...r.warnings.map(w => `<span class="muted">${esc(w)}</span>`)].join('<br>')}</td></tr>`).join('')}
      </tbody></table></div>
    <div class="row" style="margin-top:12px"><button type="button" id="c-import" class="primary" ${valid.length ? '' : 'disabled'}>Import ${valid.length} client${valid.length === 1 ? '' : 's'}</button>
      <button type="button" id="c-cancel">Cancel</button></div></div>`;
}

async function doImport() {
  const s = store.get();
  const p = ui.preview;
  const valid = p.results.filter(r => r.action !== 'error');
  const replace = ui.mode === 'replace';
  await store.commit({
    action: 'ACCOUNTS_IMPORTED', entity: 'account', entityId: 'accounts', field: 'accounts',
    before: { count: s.accounts.length },
    after: { file: ui.fileName || 'pasted rows', mode: ui.mode, rows: p.rowCount, skipped: p.results.length - valid.length },
  }, (d, ev) => {
    let added = 0, updated = 0;
    const ids = [];
    const removed = replace ? d.accounts.length : 0;
    if (replace) d.accounts = [];
    for (const r of valid) {
      const existing = !replace && r.matchId ? d.accounts.find(a => a.id === r.matchId) : null;
      if (existing) { Object.assign(existing, r.patch); updated++; ids.push(existing.id); }
      else {
        const acc = newAccount(d.accounts, replace && r.matchId ? { _newId: r.matchId, ...r.patch } : r.patch);
        d.accounts.push(acc); added++; ids.push(acc.id);
      }
    }
    Object.assign(ev.after, { added, updated, removed, accountIds: ids });
  });
  ui.preview = null;
  ui.fileName = '';
  toast(`Imported ${valid.length} client${valid.length === 1 ? '' : 's'}`);
}

// ---------------- Behaviour ----------------

function bind(root, ctx) {
  const rerender = () => render(root, { ...ctx, state: store.get(), user: store.currentUser() });
  const $ = id => root.querySelector('#' + id);

  // Users
  root.querySelectorAll('[data-u][data-f]').forEach(el => {
    const u = ui.users[+el.dataset.u];
    if (el.type === 'checkbox') el.onchange = () => { u[el.dataset.f] = el.checked; };
    else if (el.tagName === 'SELECT') el.onchange = () => { u.role = el.value; rerender(); };
    else el.oninput = () => { u.name = el.value; };
  });
  root.querySelectorAll('[data-u][data-ch]').forEach(el => el.onchange = () => {
    const u = ui.users[+el.dataset.u];
    u.channels = el.checked ? [...new Set([...u.channels, el.dataset.ch])] : u.channels.filter(c => c !== el.dataset.ch);
  });
  root.querySelectorAll('[data-u-del]').forEach(b => b.onclick = () => { ui.users.splice(+b.dataset.uDel, 1); rerender(); });
  if ($('u-add')) $('u-add').onclick = () => {
    ui.users.push({ id: store.uid('u'), name: '', role: 'seller', channels: [], canDraft: false, canApprove: false });
    rerender();
    root.querySelector(`[data-u="${ui.users.length - 1}"][data-f="name"]`)?.focus();
  };
  if ($('u-discard')) $('u-discard').onclick = () => { ui.users = null; ui.userErr = ''; rerender(); };
  if ($('u-save')) $('u-save').onclick = async () => { await saveUsers(ctx.user); rerender(); };
  root.querySelectorAll('[data-acc-role]').forEach(el => el.onchange = async () => {
    const [r, p] = el.dataset.accRole.split('|');
    await setAccess('role', r, p, +el.value);
    rerender();
  });
  root.querySelectorAll('[data-acc-user]').forEach(el => el.onchange = async () => {
    const [u, p] = el.dataset.accUser.split('|');
    await setAccess('user', u, p, el.value === '' ? undefined : +el.value);
    rerender();
  });
  if ($('acc-user')) $('acc-user').onchange = e => { ui.accUser = e.target.value; rerender(); };
  if ($('acc-user-clear')) $('acc-user-clear').onclick = async () => {
    const u = store.get().users.find(x => x.id === ui.accUser);
    for (const p of Object.keys(u.access || {})) await setAccess('user', u.id, p, undefined);
    rerender();
  };
  if ($('acc-reset')) $('acc-reset').onclick = async () => {
    if (!confirm('Reset every role to the built-in defaults? Per-person overrides stay.')) return;
    await store.commit({ action: 'CONFIG_CHANGED', entity: 'access', entityId: 'roles', field: 'accessRoles', before: null, after: { summary: 'All roles reset to defaults' } }, d => { d.accessRoles = {}; });
    toast('Roles reset');
    rerender();
  };

  // Channels
  root.querySelectorAll('[data-ch][data-f]').forEach(el => el.oninput = () => { ui.channels[+el.dataset.ch][el.dataset.f] = el.value; });
  root.querySelectorAll('[data-ch-move]').forEach(b => b.onclick = () => { move(ui.channels, b.dataset.chMove); rerender(); });
  root.querySelectorAll('[data-ch-del]').forEach(b => b.onclick = () => { ui.channels.splice(+b.dataset.chDel, 1); rerender(); });
  if ($('ch-add')) $('ch-add').onclick = () => {
    ui.channels.push({ id: '', label: '', audience: '', _new: true });
    rerender();
    root.querySelector(`[data-ch="${ui.channels.length - 1}"][data-f="label"]`)?.focus();
  };
  if ($('ch-discard')) $('ch-discard').onclick = () => { ui.channels = null; ui.chanErr = ''; rerender(); };
  if ($('ch-save')) $('ch-save').onclick = async () => { await saveChannels(); rerender(); };
  root.querySelectorAll('[data-cp]').forEach(cb => cb.onchange = () => {
    const [ch, sku] = cb.dataset.cp.split('|');
    const priced = !!cpPriced(store.get(), ch, sku);
    if (cb.checked === priced) delete ui.cp[cb.dataset.cp];
    else ui.cp[cb.dataset.cp] = { on: cb.checked, margin: ui.cp[cb.dataset.cp]?.margin ?? '' };
    rerender();
    if (cb.checked && !priced) root.querySelector(`[data-cpm="${CSS.escape(cb.dataset.cp)}"]`)?.focus();
  });
  root.querySelectorAll('[data-cpm]').forEach(el => el.oninput = () => { if (ui.cp[el.dataset.cpm]) ui.cp[el.dataset.cpm].margin = el.value; });
  if ($('cp-discard')) $('cp-discard').onclick = () => { ui.cp = {}; ui.cpErr = ''; rerender(); };
  if ($('cp-save')) $('cp-save').onclick = async () => { await saveChannelProducts(); rerender(); };

  // Products
  root.querySelectorAll('[data-sk][data-f]').forEach(el => {
    const k = ui.skus[+el.dataset.sk];
    if (el.dataset.f === 'active') el.onchange = () => { k.active = el.checked; };
    else if (el.dataset.f === 'hasVariants') el.onchange = () => { k.hasVariants = el.checked; if (!el.checked) ui.skus.filter(v => v.parentId === k.id).forEach(v => { v.parentId = null; }); rerender(); };
    else el.oninput = () => { k[el.dataset.f] = el.value; };
  });
  root.querySelectorAll('[data-sk-move]').forEach(b => b.onclick = () => { move(ui.skus, b.dataset.skMove); rerender(); });
  root.querySelectorAll('[data-sk-del]').forEach(b => b.onclick = () => {
    const k = ui.skus[+b.dataset.skDel];
    if (k.hasVariants) ui.skus.filter(v => v.parentId === k.id).forEach(v => { v.parentId = null; });
    ui.skus.splice(+b.dataset.skDel, 1);
    rerender();
  });
  root.querySelectorAll('[data-sk-addvar]').forEach(b => b.onclick = () => {
    const parent = ui.skus[+b.dataset.skAddvar];
    ui.skus.push({ id: '', label: '', contentKg: '', active: true, parentId: parent.id, _new: true });
    rerender();
    root.querySelector(`[data-sk="${ui.skus.length - 1}"][data-f="label"]`)?.focus();
  });
  if ($('sk-add')) $('sk-add').onclick = () => {
    ui.skus.push({ id: '', label: '', contentKg: '', active: true, _new: true });
    rerender();
    root.querySelector(`[data-sk="${ui.skus.length - 1}"][data-f="label"]`)?.focus();
  };
  if ($('sk-discard')) $('sk-discard').onclick = () => { ui.skus = null; ui.skuErr = ''; rerender(); };
  if ($('sk-save')) $('sk-save').onclick = async () => { await saveProducts(); rerender(); };

  // Zones
  root.querySelectorAll('[data-z]').forEach(el => el.oninput = () => { ui.zones[+el.dataset.z].name = el.value; });
  root.querySelectorAll('[data-z-move]').forEach(b => b.onclick = () => { move(ui.zones, b.dataset.zMove); rerender(); });
  root.querySelectorAll('[data-z-del]').forEach(b => b.onclick = () => { ui.zones.splice(+b.dataset.zDel, 1); rerender(); });
  if ($('z-add')) $('z-add').onclick = () => {
    ui.zones.push({ name: '', from: null });
    rerender();
    root.querySelector(`[data-z="${ui.zones.length - 1}"]`)?.focus();
  };
  if ($('z-discard')) $('z-discard').onclick = () => { ui.zones = null; ui.zoneErr = ''; rerender(); };
  if ($('z-save')) $('z-save').onclick = async () => { await saveZones(); rerender(); };

  // Competitors
  root.querySelectorAll('[data-br][data-bf]').forEach(el => el.oninput = () => {
    const b = ui.brands[+el.dataset.br];
    if (typeof b === 'string') ui.brands[+el.dataset.br] = { name: b, zone: '' };
    ui.brands[+el.dataset.br][el.dataset.bf] = el.value;
  });
  root.querySelectorAll('[data-br-del]').forEach(b => b.onclick = () => { ui.brands.splice(+b.dataset.brDel, 1); rerender(); });
  if ($('br-add')) $('br-add').onclick = () => {
    ui.brands.push({ name: '', zone: '' });
    rerender();
    root.querySelector(`[data-br="${ui.brands.length - 1}"][data-bf="name"]`)?.focus();
  };
  if ($('br-discard')) $('br-discard').onclick = () => { ui.brands = null; ui.brandErr = ''; rerender(); };
  if ($('br-save')) $('br-save').onclick = async () => { await saveBrands(); rerender(); };

  // Clients
  const preview = (text, name) => {
    ui.fileName = name;
    ui.preview = rowsToAccounts(store.get(), parseCsv(text));
    rerender();
  };
  if ($('c-file')) $('c-file').onchange = async e => { const f = e.target.files[0]; if (f) preview(await f.text(), f.name); };
  root.querySelectorAll('[name=c-mode]').forEach(r => r.onchange = () => { ui.mode = r.value; rerender(); });
  if ($('c-import')) $('c-import').onclick = async () => {
    if (ui.mode === 'replace' && !confirm(`Replace all ${store.get().accounts.length} clients with this file?`)) return;
    await doImport(); rerender();
  };
  if ($('c-cancel')) $('c-cancel').onclick = () => { ui.preview = null; ui.fileName = ''; rerender(); };
  if ($('c-template')) $('c-template').onclick = () => download('mgc-clients-template.csv', new Blob(['﻿' + toCsv(templateRows())], { type: 'text/csv' }));
  if ($('c-export')) $('c-export').onclick = () => download('mgc-clients.csv', new Blob(['﻿' + toCsv(accountsToRows(store.get().accounts))], { type: 'text/csv' }));
  if ($('c-q')) $('c-q').oninput = e => { ui.clientQuery = e.target.value; rerender(); };
  root.querySelectorAll('[data-ci]').forEach(el => {
    const [id, key] = el.dataset.ci.split('|');
    el.onchange = () => {
      (ui.inl[id] ||= {})[key] = el.value;
      const a = store.get().accounts.find(x => x.id === id);
      if (a && INLINE.every(([k]) => ui.inl[id][k] === undefined || ui.inl[id][k] === (a[k] == null ? '' : String(a[k])))) delete ui.inl[id];
      rerender();
    };
  });
  if ($('ci-discard')) $('ci-discard').onclick = () => { ui.inl = {}; ui.inlErr = ''; rerender(); };
  if ($('ci-save')) $('ci-save').onclick = async () => { await saveInline(); rerender(); };

  // Client terms
  root.querySelectorAll('[data-c-edit]').forEach(b => b.onclick = () => {
    ui.editClient = b.dataset.cEdit;
    ui.terms = {};
    ui.basic = {};
    ui.clientErr = '';
    rerender();
    root.querySelector('[data-ct]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  root.querySelectorAll('[data-ct]').forEach(el => {
    const write = () => { ui.terms[el.dataset.ct] = el.value; };
    el.oninput = write;
    el.onchange = () => { write(); rerender(); };
  });
  root.querySelectorAll('[data-cb]').forEach(el => {
    const write = () => { ui.basic[el.dataset.cb] = el.value; };
    el.oninput = write;
    el.onchange = () => { write(); rerender(); };
  });
  if ($('ct-cancel')) $('ct-cancel').onclick = () => { ui.editClient = null; ui.terms = {}; ui.basic = {}; ui.clientErr = ''; rerender(); };
  if ($('ct-save')) $('ct-save').onclick = async () => { await saveTerms(); rerender(); };
}
