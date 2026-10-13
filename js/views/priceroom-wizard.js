// Price change wizard: Draft → Simulate → Review → Approve → Publish, enforced in order.
// Simulate is pure (writes only a SIMULATE event). Publish is one atomic commit.

import * as store from '../store.js';
import { canEdit, canApprove } from '../access.js';
import { fmt, fmtSigned, toCentavos, toInput } from '../money.js';
import { esc, toast, options, preserveFocus } from '../ui.js';
import {
  byId, simulate, applyChanges, describeChange, CHANGE_TYPES, componentKind, currentCostBasis, marginRule, bufferFor,
  currentPublication, allBoardPrices, skuLabel, channelLabel, userName, fmtDateTime,
} from '../pricing.js';

const STEPS = [['draft', 'Draft'], ['simulate', 'Simulate'], ['review', 'Review'], ['approve', 'Approve'], ['publish', 'Publish']];

const fresh = () => ({
  proposalId: null, step: 'draft', objective: '', changes: [], drafterId: null,
  instructedBy: '', verifiedBy: '', error: '', simKey: null, sharedParam: null, showAll: false, published: null, simSearch: '',
  add: { type: 'ACQ', channelId: 'DEALER', skuId: '11KG_MGAS', accountId: '', code: '', value: '', remove: false },
});
let w = fresh();

const keyOf = changes => JSON.stringify(changes);

function encode(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode(param) {
  const b64 = param.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(b64 + '==='.slice((b64.length + 3) % 4)))));
}

// Keeps the rest of the Price room query (board tab) and only sets or clears the shared simulation.
function setHash(sim) {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  if (sim) qs.set('sim', sim); else qs.delete('sim');
  const str = qs.toString();
  history.replaceState(null, '', `#/priceroom${str ? '?' + str : ''}`);
}

// The proposal being built, so the boards can preview it. Cumulative across every board.
export function pendingChanges() {
  return w.step === 'done' ? [] : w.changes;
}

// Used by the client pricing grid: merge a batch of changes into the open proposal.
// Editing the set invalidates any simulation, so the wizard returns to Draft.
export function addChanges(list) {
  for (const c of list) {
    const same = x => x.type === c.type && x.accountId === c.accountId && x.code === c.code && x.channelId === c.channelId && x.skuId === c.skuId;
    w.changes = [...w.changes.filter(x => !same(x)), c];
  }
  if (w.step !== 'draft') w.step = 'draft';
  w.simKey = null;
  return w.changes.length;
}

// Review (03) and Approve (04) write nothing, so the stored status can't tell them apart from Simulate (02).
// Remember the last stage per proposal in this browser so reopening resumes where it was left.
const RESUME_KEY = 'mgc_pricing_v1_resume';
function readResume() {
  try { return JSON.parse(localStorage.getItem(RESUME_KEY)) || {}; } catch { return {}; }
}
function writeResume(r) {
  try { localStorage.setItem(RESUME_KEY, JSON.stringify(r)); } catch { /* storage unavailable */ }
}
function rememberStage() {
  if (!w.proposalId) return;
  const r = readResume();
  if (['simulate', 'review', 'approve'].includes(w.step)) r[w.proposalId] = { step: w.step, instructedBy: w.instructedBy, verifiedBy: w.verifiedBy };
  else delete r[w.proposalId];
  writeResume(r);
}
// Only resume past Simulate while the proposal is still simulated for exactly these changes.
function resumeFor(p) {
  const saved = readResume()[p.id];
  if (p.status !== 'simulated' || !saved || p.simKey !== keyOf(p.changes)) return null;
  return saved;
}

// Load a simulation shared by URL. Viewing it writes nothing.
export function loadShared(param, s) {
  if (w.sharedParam === param) return;
  try {
    const obj = decode(param);
    const existing = obj.proposalId ? s.proposals.find(p => p.id === obj.proposalId) : null;
    const saved = existing && keyOf(obj.changes || []) === keyOf(existing.changes) ? resumeFor(existing) : null;
    w = fresh();
    Object.assign(w, {
      proposalId: existing && existing.status !== 'published' ? existing.id : null,
      objective: obj.objective || '', changes: obj.changes || [], drafterId: existing?.draftedBy ?? null,
      simKey: existing?.simKey ?? null, step: existing?.status === 'approved' ? 'publish' : saved?.step ?? 'simulate', sharedParam: param,
      instructedBy: existing?.instructedBy ?? saved?.instructedBy ?? '', verifiedBy: existing?.verifiedBy ?? saved?.verifiedBy ?? '',
    });
  } catch {
    w = fresh();
    w.sharedParam = param;
    w.error = 'The shared simulation link could not be read.';
  }
}

export function openProposal(p) {
  const saved = resumeFor(p);
  w = fresh();
  Object.assign(w, {
    proposalId: p.id, objective: p.objective, changes: p.changes, drafterId: p.draftedBy, simKey: p.simKey ?? null,
    instructedBy: p.instructedBy ?? saved?.instructedBy ?? '', verifiedBy: p.verifiedBy ?? saved?.verifiedBy ?? '',
    step: p.status === 'approved' ? 'publish' : saved ? saved.step : p.status === 'simulated' ? 'simulate' : 'draft',
  });
  if (w.step !== 'draft') {
    w.sharedParam = encode({ proposalId: p.id, objective: p.objective, changes: p.changes });
    setHash(w.sharedParam);
  } else setHash(null);
}

// ---------------- HTML ----------------

let propsOpen = false, propsSeen = false;

// Back / Continue for each stage: the ids stay the same as the old in-body buttons so the bindings below still apply.
function nav(s, user, logged) {
  const none = { back: null, next: null };
  const approveOk = canApprove(s, user, 'mpl_approve'), publishOk = canApprove(s, user, 'mpl_publish');
  const draftOk = canEdit(s, user, 'mpl_draft');
  return {
    draft: { back: null, next: { id: 'w-sim', label: 'Continue', off: !draftOk, tip: draftOk ? '' : 'Your access does not include drafting proposals' } },
    simulate: { back: { id: 'w-back-draft', label: 'Back to draft' }, next: { id: 'w-to-review', label: 'Continue', off: !logged, tip: logged ? '' : 'Run the simulation first' } },
    review: { back: { id: 'w-back-sim', label: 'Back' }, next: { id: 'w-to-approve', label: 'Continue' } },
    approve: { back: { id: 'w-back-review', label: 'Back' }, next: { id: 'w-approve', label: 'Approve', off: !approveOk, tip: approveOk ? '' : 'Your access does not include approving proposals' } },
    publish: { back: { id: 'w-back-approve', label: 'Back' }, next: { id: 'w-publish', label: 'Publish', off: !publishOk, tip: publishOk ? '' : 'Your access does not include publishing' } },
    done: none,
  }[w.step] || none;
}

export function html(s, user) {
  rememberStage();
  const idx = STEPS.findIndex(([k]) => k === w.step);
  const bar = `<ol class="chevrons" aria-label="Stages">${STEPS.map(([k, l], i) => {
    const cls = w.step === 'done' || i < idx ? 'done' : i === idx ? 'on' : '';
    return `<li class="${cls}"${i === idx ? ' aria-current="step"' : ''}><span class="n">${String(i + 1).padStart(2, '0')}</span><span class="t">${l}</span></li>`;
  }).join('')}</ol>`;
  const body = { draft: draftHtml, simulate: simulateHtml, review: reviewHtml, approve: approveHtml, publish: publishHtml, done: doneHtml }[w.step](s, user);
  const open = s.proposals.filter(p => p.status !== 'published').sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const logged = w.simKey === keyOf(w.changes) && !!w.proposalId;
  const nv = nav(s, user, logged);
  const btn = (b, primary) => (b ? `<button type="button" id="${b.id}" class="small ${primary ? 'primary' : ''}" ${b.off ? `disabled title="${esc(b.tip || '')}"` : ''}>${esc(b.label)}</button>` : '');
  return `<div class="wiz-head">
      <div class="wiz-bar">
        <input type="search" id="w-sim-search" class="grow" placeholder="Search accounts" aria-label="Search accounts" value="${esc(w.simSearch)}" autocomplete="off" ${w.step === 'simulate' ? '' : 'disabled'}>
        <button type="button" id="w-props" class="small ${propsOpen ? 'on' : ''}" aria-expanded="${propsOpen}"><b class="cnt">${open.length}</b> Open proposals</button>
        <button type="button" id="w-new" class="small">New</button>
        ${btn(nv.back, false)}${btn(nv.next, true)}
      </div>
      ${bar}
    </div>
    ${w.error ? `<div class="banner red" role="alert">${esc(w.error)}</div>` : ''}
    ${body}
    <div id="w-sheet" class="props-sheet ${propsOpen && propsSeen ? 'open' : ''}" aria-label="Open proposals">
      <div class="props-head"><b><span class="cnt">${open.length}</span> Open proposals</b><button type="button" id="w-props-x" class="icon small" aria-label="Close">✕</button></div>
      ${open.length ? `<div class="table-wrap"><table><tbody>${open.map(p => `<tr><td><b>${esc(p.objective)}</b><br>
        <span class="small muted">${esc(p.changes.map(c => describeChange(s, c)).join('; '))}</span></td>
        <td><span class="pill ${p.status === 'approved' ? 'green' : 'amber'}">${esc(p.status[0].toUpperCase() + p.status.slice(1))}</span></td>
        <td class="small muted">Drafted by ${esc(userName(s, p.draftedBy))}<br>${fmtDateTime(p.updatedAt)}</td>
        <td><button type="button" class="small" data-open-prop="${esc(p.id)}">Open</button></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted small" style="padding:8px 12px">None.</p>'}
    </div>`;
}

function changeList(s, editable) {
  if (!w.changes.length) return '<p class="muted small">No changes yet.</p>';
  return `<ul class="change-list">${w.changes.map((c, i) => `<li>
    <span class="grow"><span class="small muted">${esc(CHANGE_TYPES[c.type])}</span> · ${esc(describeChange(s, c))}</span>
    ${editable ? `<button type="button" class="icon small" data-del-change="${i}" aria-label="Remove change">✕</button>` : ''}</li>`).join('')}</ul>`;
}

// Compact calculator: one line of inputs, the current value as a hint underneath.
// Which kinds of change this user may add: each follows the access part for that lever.
const TYPE_PART = { ACQ: ['mpl_cost'], HAULING: ['mpl_cost'], MARGIN: ['mpl_margin'], BUFFER: ['mpl_buffer'], ACCOUNT_COMPONENT: ['cp_premiums', 'cp_supply', 'cp_compete', 'cp_cash'] };
const typeAllowed = (s, user, id) => (TYPE_PART[id] || []).some(p => canEdit(s, user, p));

function draftHtml(s, user) {
  if (!canEdit(s, user, 'mpl_draft')) {
    return `<p class="muted">You can see proposals but not draft or simulate changes.</p>${changeList(s, false)}`;
  }
  const allowed = Object.keys(CHANGE_TYPES).filter(id => id !== 'ACCOUNT_FIELD' && typeAllowed(s, user, id));
  if (!allowed.length) return `<p class="muted">Your access does not include any of the levers a proposal can change.</p>${changeList(s, false)}`;
  if (!allowed.includes(w.add.type)) w.add = { ...w.add, type: allowed[0], value: '', code: '', remove: false };
  const cb = currentCostBasis(s);
  const a = w.add;
  const chSel = `<select id="w-ch" aria-label="Channel">${options(s.channels, a.channelId)}</select>`;
  const accSel = `<select id="w-acc" aria-label="Client">${options(s.accounts, a.accountId, { placeholder: 'Client' })}</select>`;
  const removeT = `<label class="check"><input id="w-remove" type="checkbox" ${a.remove ? 'checked' : ''}> Remove</label>`;
  let extra = '', hint = '', ph = '₱/kg';
  if (a.type === 'ACQ') hint = `Now ${fmt(cb.acqPerKg)}/kg`;
  if (a.type === 'HAULING') hint = `Now ${fmt(cb.haulingPerKg)}/kg`;
  if (a.type === 'MARGIN') {
    const cur = marginRule(s, a.channelId, a.skuId);
    extra = chSel + `<select id="w-sku" aria-label="Product">${options(s.skus, a.skuId)}</select>`;
    hint = cur ? `Now ${fmt(cur.perKg)}/kg` : 'Not priced on this channel yet';
  }
  if (a.type === 'BUFFER') { extra = chSel; ph = '±₱/kg'; hint = `Now ${fmt(bufferFor(s, a.channelId))}/kg · negative allowed`; }
  if (a.type === 'ACCOUNT_COMPONENT') {
    const comps = [
      ...s.premiumComponents.map(c => ({ id: c.code, label: `+ ${c.label}` })),
      ...s.discountComponents.map(c => ({ id: c.code, label: `− ${c.label}` })),
    ];
    extra = accSel + `<select id="w-code" aria-label="Premium or discount">${options(comps, a.code, { placeholder: 'Premium or discount' })}</select>` + removeT;
    ph = '₱/kg';
    hint = 'Premiums add, discounts subtract. Leave ₱/kg blank to use the catalogue rate or formula.';
  }

  return `<div class="calc">
      <input id="w-obj" class="calc-obj" type="text" maxlength="160" aria-label="Objective (required)" placeholder="Objective (required) — e.g. Pass through September acquisition increase" value="${esc(w.objective)}">
      <div class="calc-row">
        <select id="w-type" aria-label="What changes">${options(Object.entries(CHANGE_TYPES).filter(([id]) => allowed.includes(id)).map(([id, label]) => ({ id, label })), a.type)}</select>
        ${extra}
        ${a.remove ? '' : `<input id="w-val" class="calc-val" type="text" inputmode="decimal" aria-label="Amount per kg" placeholder="${esc(ph)}" value="${esc(a.value)}">`}
        <button type="button" id="w-add" class="primary">Add</button>
      </div>
      ${hint ? `<div class="calc-hint">${esc(hint)}</div>` : ''}
      <div class="calc-channels">
        ${['BULK', 'COMMERCIAL'].filter(id => byId(s.channels, id)).map(id => `<button type="button" class="small" data-grid="${id}">${esc(channelLabel(s, id))} clients</button>`).join('')}
      </div>
    </div>
    ${changeList(s, true)}`;
}

function impactClass(v) {
  return v > 0 ? 'neg' : v < 0 ? 'pos' : '';
}

function simulateHtml(s) {
  const sim = simulate(s, w.changes, new Date().toISOString());
  const logged = w.simKey === keyOf(w.changes) && !!w.proposalId;
  const rows = sim.channelRows.filter(r => w.showAll || r.deltaPerCyl || (r.beforePerCyl == null) !== (r.afterPerCyl == null));
  const accName = id => byId(s.accounts, id)?.name ?? id;
  const d = v => (v == null ? '—' : fmtSigned(v));

  return `${changeList(s, false)}
    <div class="strip">
      <div><b class="${impactClass(sim.monthlyImpact)}">${fmtSigned(sim.monthlyImpact)}</b><span>Estimated monthly peso impact</span></div>
      <div><b>${sim.excludedNullVolume.length}</b><span>Accounts excluded (no volume on record)</span></div>
      <div><b>${sim.newlyBelowFloor.length}</b><span>Newly below floor</span></div>
      <div><b>${sim.crossesCompetitor.length}</b><span>Cross above competitor</span></div>
    </div>
    ${sim.excludedNullVolume.length ? `<details class="small muted"><summary>${sim.excludedNullVolume.length} excluded accounts</summary>${esc(sim.excludedNullVolume.map(accName).join(', '))}.</details>` : ''}
    <div class="cols">
      <div>
        <h3><span class="cnt">${sim.newlyBelowFloor.length}</span> Accounts newly below floor</h3>
        ${sim.newlyBelowFloor.length ? `<ul>${sim.newlyBelowFloor.map(x => `<li><b>${esc(accName(x.accountId))}</b> — ${fmt(-x.marginVsFloorPerKg)}/kg below floor</li>`).join('')}</ul>` : '<p class="muted small">None.</p>'}
        <h3><span class="cnt">${sim.crossesCompetitor.length}</span> Accounts crossing above the newest competitor reading</h3>
        ${sim.crossesCompetitor.length ? `<ul>${sim.crossesCompetitor.map(x => { const r = s.competitorReadings.find(c => c.id === x.readingId); return `<li><b>${esc(accName(x.accountId))}</b> — ${fmt(x.afterGrossPerCyl)} vs ${esc(r.brand)} ${fmt(r.pricePerCyl)}</li>`; }).join('')}</ul>` : '<p class="muted small">None.</p>'}
        <h3><span class="cnt">${sim.accountRows.length}</span> Accounts</h3>
        <div class="table-wrap"><table><thead><tr><th>Account</th><th class="num">Δ/kg</th><th class="num">Vol kg/mo</th><th class="num">Monthly</th></tr></thead><tbody>
        ${sim.accountRows.filter(r => { const q = w.simSearch.toLowerCase(); return !q || accName(r.accountId).toLowerCase().includes(q); }).map(r => `<tr><td>${esc(accName(r.accountId))}<br><span class="small muted">${esc(skuLabel(s, r.skuId))} <span class="was">${fmt(r.beforePerKg)}</span> → <span class="now">${fmt(r.afterPerKg)}</span></span></td>
          <td class="num">${d(r.deltaPerKg)}</td><td class="num">${r.volumeKg == null ? '<span class="muted">none</span>' : r.volumeKg.toLocaleString('en-PH')}</td>
          <td class="num">${r.impact == null ? '<span class="muted">excluded</span>' : fmtSigned(r.impact)}</td></tr>`).join('')}
        </tbody></table></div>
      </div>
      <div>
        <div class="row"><h3 class="grow">Channel × product, before and after</h3>
          <label class="toggle small"><input id="w-showall" type="checkbox" ${w.showAll ? 'checked' : ''}> Show unchanged</label></div>
        <div class="table-wrap"><table><thead><tr><th>Channel · product</th><th class="num">Per kg</th><th class="num">Δ/kg</th><th class="num">Per cyl, net</th><th class="num">Δ/cyl</th></tr></thead><tbody>
        ${rows.length ? rows.map(r => `<tr><td>${esc(channelLabel(s, r.channelId))}<br><span class="small muted">${esc(skuLabel(s, r.skuId))}</span></td>
          <td class="num"><span class="was">${fmt(r.beforePerKg)}</span><br><span class="now">${fmt(r.afterPerKg)}</span></td><td class="num">${d(r.deltaPerKg)}</td>
          <td class="num"><span class="was">${fmt(r.beforePerCyl)}</span><br><span class="now">${fmt(r.afterPerCyl)}</span></td><td class="num">${d(r.deltaPerCyl)}</td></tr>`).join('')
          : '<tr><td colspan="5" class="muted">No channel list prices change.</td></tr>'}
        </tbody></table></div>
      </div>
    </div>
    <div class="row" style="margin-top:10px">
      <button type="button" id="w-rerun" class="small">${w.proposalId ? 'Re-run simulation' : 'Save as my draft and simulate'}</button>
      <button type="button" id="w-share" class="small">Copy share link</button>
      ${logged ? '' : '<span class="small muted">Run the simulation first.</span>'}
    </div>`;
}

function reviewHtml(s) {
  const sim = simulate(s, w.changes, new Date().toISOString());
  return `<h3>What will change</h3>
    ${sim.review.length ? `<ul class="stack">${sim.review.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : '<p class="muted">No prices change.</p>'}
    <p>Estimated monthly impact <b>${fmtSigned(sim.monthlyImpact)}</b>${sim.excludedNullVolume.length ? `, excluding ${sim.excludedNullVolume.length} accounts with no volume` : ''}.</p>
`;
}

function approveHtml(s, user) {
  const managers = s.users.filter(u => u.role === 'manager' || u.role === 'admin');
  const clash = w.verifiedBy && w.verifiedBy === w.drafterId;
  return `<div class="row">
      <label class="field grow"><span>Instructed by</span><select id="w-instr">${options(s.users.filter(u => u.role !== 'messenger'), w.instructedBy, { label: u => u.name, placeholder: 'Choose who instructed this' })}</select></label>
      <label class="field grow"><span>Verified by</span><select id="w-verif">${options(managers, w.verifiedBy, { label: u => u.name + (u.canApprove ? ' — may approve' : ''), placeholder: 'Choose verifier' })}</select></label>
    </div>
    ${clash ? `<p class="err" role="alert">The verifier must be a different person from the drafter (${esc(userName(s, w.drafterId))}). Choose another verifier.</p>` : ''}
`;
}

function publishHtml(s, user) {
  const pub = currentPublication(s);
  return `<div class="card stack">
    <div><b>${esc(w.objective)}</b></div>
    ${changeList(s, false)}
    <div class="table-wrap"><table><tbody>
      <tr><td>Drafted by</td><td>${esc(userName(s, w.drafterId))}</td></tr>
      <tr><td>Instructed by</td><td>${esc(userName(s, w.instructedBy))}</td></tr>
      <tr><td>Verified by</td><td>${esc(userName(s, w.verifiedBy))}</td></tr>
      <tr><td>Publishing as</td><td>${esc(user.name)}</td></tr>
      <tr><td>Board</td><td>v${pub.version} → <b>v${pub.version + 1}</b>, effective now</td></tr>
    </tbody></table></div>
${canApprove(s, user, 'mpl_publish') ? '' : '<p class="small muted">Your access does not include publishing.</p>'}
  </div>`;
}

function doneHtml(s) {
  return `<div class="banner green">Published — price list v${w.published} is live on every price list and the Quote desk.</div>
    <div class="row">${s.channels.map(c => `<a class="btn small" href="#/board/${esc(c.id)}">${esc(c.label)}</a>`).join('')}</div>`;
}

// ---------------- Behaviour ----------------

export function bind(root, user, rerender) {
  const $ = id => root.querySelector('#' + id);
  const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };
  const go = step => { w.error = ''; w.step = step; rerender(); };

  on('w-new', 'onclick', () => { w = fresh(); setHash(null); propsOpen = propsSeen = false; rerender(); });
  root.querySelectorAll('[data-open-prop]').forEach(b => b.onclick = () => {
    const p = store.get().proposals.find(x => x.id === b.dataset.openProp);
    propsOpen = propsSeen = false;
    if (p) { openProposal(p); rerender(); }
  });
  // Open proposals: a sheet that slides up from the bottom of the panel; slides back down on ✕, the button, or a double click.
  const sheet = $('w-sheet');
  const closeSheet = () => {
    if (!sheet) return;
    sheet.classList.remove('open');
    propsOpen = propsSeen = false;
    setTimeout(() => { if (sheet.isConnected) rerender(); }, 260);
  };
  on('w-props', 'onclick', () => {
    if (propsOpen) return closeSheet();
    propsOpen = true;
    if (sheet) { propsSeen = true; sheet.classList.add('open'); $('w-props')?.classList.add('on'); }
  });
  on('w-props-x', 'onclick', closeSheet);
  if (sheet) sheet.ondblclick = e => { if (!e.target.closest('button')) closeSheet(); };
  if (sheet && propsOpen && !propsSeen) { propsSeen = true; requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('open'))); }
  const head = root.querySelector('.wiz-head');
  if (head) root.style.setProperty('--wiz-h', head.offsetHeight + 'px');

  // Draft
  on('w-obj', 'oninput', e => { w.objective = e.target.value; });
  on('w-type', 'onchange', e => { w.add = { ...w.add, type: e.target.value, value: '', code: '', remove: false }; rerender(); });
  on('w-ch', 'onchange', e => { w.add.channelId = e.target.value; rerender(); });
  on('w-sku', 'onchange', e => { w.add.skuId = e.target.value; rerender(); });
  on('w-acc', 'onchange', e => { w.add.accountId = e.target.value; rerender(); });
  on('w-code', 'onchange', e => { w.add.code = e.target.value; rerender(); });
  on('w-remove', 'onchange', e => { w.add.remove = e.target.checked; rerender(); });
  on('w-val', 'oninput', e => { w.add.value = e.target.value; });
  on('w-add', 'onclick', () => { addChange(); rerender(); });
  root.querySelectorAll('[data-del-change]').forEach(b => b.onclick = () => { w.changes.splice(+b.dataset.delChange, 1); rerender(); });
  on('w-sim', 'onclick', async () => { await saveDraftAndSimulate(user); rerender(); });

  // Simulate
  on('w-back-draft', 'onclick', () => go('draft'));
  on('w-sim-search', 'oninput', e => { w.simSearch = e.target.value; preserveFocus(root, rerender); });
  on('w-showall', 'onchange', e => { w.showAll = e.target.checked; rerender(); });
  on('w-rerun', 'onclick', async () => { await saveDraftAndSimulate(user); rerender(); });
  on('w-share', 'onclick', async () => {
    const url = location.href.split('#')[0] + `#/priceroom?sim=${encode({ proposalId: w.proposalId, objective: w.objective, changes: w.changes })}`;
    try { await navigator.clipboard.writeText(url); toast('Share link copied'); } catch { prompt('Copy this link', url); }
  });
  on('w-to-review', 'onclick', () => { if (w.simKey === keyOf(w.changes) && w.proposalId) go('review'); });

  // Review
  on('w-back-sim', 'onclick', () => go('simulate'));
  on('w-to-approve', 'onclick', () => go('approve'));

  // Approve
  on('w-instr', 'onchange', e => { w.instructedBy = e.target.value; rerender(); });
  on('w-verif', 'onchange', e => { w.verifiedBy = e.target.value; w.error = ''; rerender(); });
  on('w-back-review', 'onclick', () => go('review'));
  on('w-back-approve', 'onclick', () => go('approve'));
  on('w-approve', 'onclick', async () => { await approve(); rerender(); });

  // Publish
  on('w-publish', 'onclick', async () => { await publish(user); rerender(); });
}

function addChange() {
  const s = store.get();
  const a = w.add;
  w.error = '';
  const val = a.value.trim() === '' ? null : toCentavos(a.value);
  let c;
  if (a.type === 'ACQ' || a.type === 'HAULING') {
    if (val == null || val <= 0) return (w.error = 'Enter the new per-kg amount, for example 67.00');
    c = { type: a.type, perKg: val };
  } else if (a.type === 'MARGIN') {
    if (val == null || val < 0) return (w.error = 'Enter the new margin per kg, for example 18.50');
    c = { type: 'MARGIN', channelId: a.channelId, skuId: a.skuId, perKg: val };
  } else if (a.type === 'BUFFER') {
    if (val == null) return (w.error = 'Enter the buffer per kg — use a minus sign for a negative buffer');
    c = { type: 'BUFFER', channelId: a.channelId, perKg: val };
  } else {
    if (!a.accountId) return (w.error = 'Choose a client');
    if (!a.code) return (w.error = 'Choose a premium or discount');
    if (componentKind(s, a.code) === 'discounts' && !a.remove && (val == null || val <= 0)) return (w.error = 'Enter the discount per kg, for example 6.25');
    if (val != null && val < 0) return (w.error = 'Enter a positive amount per kg');
    c = { type: 'ACCOUNT_COMPONENT', accountId: a.accountId, code: a.code, rows: a.remove ? [] : [{ perKg: val }] };
  }
  const same = x => x.type === c.type && x.channelId === c.channelId && x.skuId === c.skuId && x.accountId === c.accountId && x.code === c.code;
  w.changes = [...w.changes.filter(x => !same(x)), c];
  w.add.value = '';
  void s;
}

async function saveDraftAndSimulate(user) {
  w.error = '';
  if (!canEdit(store.get(), user, 'mpl_draft')) { w.error = 'Your access does not include drafting proposals'; return; }
  if (!w.objective.trim()) { w.error = 'Write a one-line objective — it is required before simulating'; w.step = 'draft'; return; }
  if (!w.changes.length) { w.error = 'Add at least one change before simulating'; w.step = 'draft'; return; }

  const s = store.get();
  const existing = w.proposalId ? s.proposals.find(p => p.id === w.proposalId) : null;
  if (!existing) { w.proposalId = store.uid('prop'); w.drafterId = user.id; }
  const changedSinceDraft = !existing || keyOf(existing.changes) !== keyOf(w.changes) || existing.objective !== w.objective;

  // Put the share state in the URL before committing, so the re-render the commit triggers keeps this wizard.
  w.sharedParam = encode({ proposalId: w.proposalId, objective: w.objective, changes: w.changes });
  setHash(w.sharedParam);

  const cause = w.changes.map(c => describeChange(s, c)).join('; ');
  const now = new Date().toISOString();
  if (changedSinceDraft) {
    await store.commit({
      action: 'DRAFT', entity: 'proposal', entityId: w.proposalId, proposalId: w.proposalId, objective: w.objective,
      before: existing ? { changes: existing.changes } : null, after: { changes: w.changes, cause },
    }, d => {
      const p = d.proposals.find(x => x.id === w.proposalId);
      const row = { id: w.proposalId, objective: w.objective, changes: w.changes, draftedBy: w.drafterId, status: 'draft', simKey: null, instructedBy: null, verifiedBy: null, updatedAt: now };
      if (p) Object.assign(p, row); else d.proposals.push(row);
    });
  }

  const sim = simulate(store.get(), w.changes, now);
  const key = keyOf(w.changes);
  await store.commit({
    action: 'SIMULATE', entity: 'proposal', entityId: w.proposalId, proposalId: w.proposalId, objective: w.objective,
    after: {
      cause: sim.cause, monthlyImpact: sim.monthlyImpact, excludedCount: sim.excludedNullVolume.length,
      newlyBelowFloor: sim.newlyBelowFloor.length, crossesCompetitor: sim.crossesCompetitor.length,
      accountIds: sim.accountRows.filter(r => r.deltaPerKg).map(r => r.accountId),
    },
  }, d => {
    const p = d.proposals.find(x => x.id === w.proposalId);
    Object.assign(p, { status: 'simulated', simKey: key, instructedBy: null, verifiedBy: null, updatedAt: now });
  });
  w.simKey = key;
  w.instructedBy = '';
  w.verifiedBy = '';
  w.step = 'simulate';
}

async function approve() {
  const s = store.get();
  if (!canApprove(s, store.currentUser(), 'mpl_approve')) { w.error = 'Your access does not include approving proposals'; return; }
  const p = s.proposals.find(x => x.id === w.proposalId);
  w.error = '';
  if (!p || p.simKey !== keyOf(w.changes)) { w.error = 'This proposal has changed since it was simulated — simulate again first'; w.step = 'simulate'; return; }
  if (!w.instructedBy) { w.error = 'Choose who instructed this change'; return; }
  if (!w.verifiedBy) { w.error = 'Choose who verified this change'; return; }
  if (w.verifiedBy === p.draftedBy) { w.error = `Approval blocked: the verifier must be a different person from the drafter (${userName(s, p.draftedBy)})`; return; }

  await store.commit({
    action: 'APPROVE', entity: 'proposal', entityId: p.id, proposalId: p.id, objective: p.objective,
    instructedBy: w.instructedBy, verifiedBy: w.verifiedBy, after: { draftedBy: p.draftedBy, cause: p.changes.map(c => describeChange(s, c)).join('; ') },
  }, d => {
    Object.assign(d.proposals.find(x => x.id === p.id), { status: 'approved', instructedBy: w.instructedBy, verifiedBy: w.verifiedBy, updatedAt: new Date().toISOString() });
  });
  w.step = 'publish';
  toast('Approved');
}

async function publish(user) {
  const s = store.get();
  if (!canApprove(s, user, 'mpl_publish')) { w.error = 'Your access does not include publishing'; return; }
  const p = s.proposals.find(x => x.id === w.proposalId);
  w.error = '';
  if (!p || p.status !== 'approved') { w.error = 'This proposal is not approved — approve it before publishing'; w.step = 'approve'; return; }
  if (keyOf(p.changes) !== keyOf(w.changes)) { w.error = 'The changes differ from what was approved — simulate and approve again'; w.step = 'draft'; return; }
  if (p.verifiedBy === p.draftedBy) { w.error = 'The verifier must be a different person from the drafter'; w.step = 'approve'; return; }

  const when = new Date().toISOString();
  const sim = simulate(s, p.changes, when);
  const cur = currentPublication(s);
  const version = cur.version + 1;
  const accountIds = [...new Set([
    ...sim.accountRows.filter(r => r.deltaPerKg).map(r => r.accountId),
    ...p.changes.filter(c => c.accountId).map(c => c.accountId),
  ])];

  await store.commit({
    action: 'PUBLISH', entity: 'publication', entityId: `board_v${version}`, proposalId: p.id, objective: p.objective,
    instructedBy: p.instructedBy, verifiedBy: p.verifiedBy,
    before: { version: cur.version },
    after: { version, cause: sim.cause, review: sim.review, changes: p.changes, accountIds, monthlyImpact: sim.monthlyImpact, draftedBy: p.draftedBy, publishedBy: user.id },
    hashOf: { version, when, changes: p.changes, review: sim.review },
  }, (d, ev) => {
    const prev = currentPublication(d);
    if (!prev.prices) prev.prices = allBoardPrices(d); // freeze the outgoing board before tables change
    const next = applyChanges(d, p.changes, when, store.uid);
    d.costBasis = next.costBasis;
    d.marginRules = next.marginRules;
    d.buffers = next.buffers;
    d.accounts = next.accounts;
    d.publications.push({
      version, publishedAt: when, proposalId: p.id, objective: p.objective,
      draftedBy: p.draftedBy, instructedBy: p.instructedBy, verifiedBy: p.verifiedBy, publishedBy: user.id,
      snapshotHash: ev.snapshotHash, prices: allBoardPrices(d),
    });
    Object.assign(d.proposals.find(x => x.id === p.id), { status: 'published', publishedAt: when, version, updatedAt: when });
  });

  w = { ...fresh(), step: 'done', published: version };
  setHash(null);
  toast('Published');
}
