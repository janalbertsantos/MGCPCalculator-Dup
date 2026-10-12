// Price Watch — field data capture. Compact form optimized for quick entry.

import * as store from '../store.js';
import { fmt, toCentavos } from '../money.js';
import { esc, toast, options, preserveFocus } from '../ui.js';
import { newestReading, isStaleReading, daysSince, fmtDate, userName, channelLabel } from '../pricing.js';

const ui = { dueOpen: true, recentOpen: true, channelId: '', productBrand: '', brand: '', brandOther: '', skuId: '11KG_MGAS', price: '', photoUrl: null, photoName: '', noCamera: false, error: '', outlier: null };

function brandName(b) { return typeof b === 'string' ? b : b.name; }
function brandZone(b) { return typeof b === 'string' ? '' : (b.zone || ''); }

function brands(s) {
  const tracked = (s.trackedBrands || []).map(brandName);
  return [...new Set([...tracked, ...s.competitorReadings.map(r => r.brand)])].sort();
}

function zoneForBrand(s, name) {
  const entry = (s.trackedBrands || []).find(b => brandName(b) === name);
  return entry ? brandZone(entry) : '';
}

export function render(root, ctx) {
  preserveFocus(root, () => { root.innerHTML = view(ctx); });
  bind(root, ctx);
}

function view({ state: s, user }) {
  const now = new Date();
  const today = now.toDateString();
  const todayCount = s.competitorReadings.filter(r => r.capturedBy === user.id && new Date(r.capturedAt).toDateString() === today).length;

  const due = [];
  for (const entry of s.trackedBrands || []) {
    const name = brandName(entry);
    const zone = brandZone(entry);
    if (!zone) continue;
    const r = newestReading(s, { zone, brand: name });
    if (!r || isStaleReading(s, r, now)) due.push({ brand: name, zone, r });
  }

  const recent = [...s.competitorReadings].sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1)).slice(0, 12);
  const brandList = brands(s);
  const skuList = s.skus.filter(k => k.active);
  const selectedZone = ui.brand && ui.brand !== '__other' ? zoneForBrand(s, ui.brand) : '';

  return `<section class="page narrow">
    <div class="page-head"><div><h1>Price Watch</h1></div></div>
    <section class="cpw-sec cpw-main">
    <div class="cpw-sec-head"><h2>Submit reading</h2><span class="cpw-count">Today: ${todayCount} submitted</span></div>
    <div class="cpw-form">
      <div class="cpw-row">
        <label class="field cpw-f"><span>Channel</span>
          <select id="m-channel">${options(s.channels, ui.channelId, { placeholder: 'Choose' })}</select></label>
        <label class="field cpw-f"><span>Brand</span>
          <input id="m-pbrand" type="text" list="m-pbrands" placeholder="e.g. Gasul" value="${esc(ui.productBrand)}" autocomplete="off">
          <datalist id="m-pbrands">${[...new Set(s.competitorReadings.map(r => r.productBrand).filter(Boolean))].map(b => `<option value="${esc(b)}"></option>`).join('')}</datalist></label>
      </div>
      <div class="cpw-row">
        <label class="field cpw-f"><span>Partner (Competitor)</span>
          <select id="m-brand">${options(brandList.map(b => ({ id: b, label: b })), ui.brand, { placeholder: 'Choose' })}<option value="__other"${ui.brand === '__other' ? ' selected' : ''}>Other</option></select></label>
        ${ui.brand === '__other' ? `<label class="field cpw-f"><span>Brand name</span><input id="m-brand-other" type="text" value="${esc(ui.brandOther)}"></label>` : ''}
      </div>
      <div class="cpw-row">
        <label class="field cpw-f"><span>Product</span><select id="m-sku">${options(skuList, ui.skuId)}</select></label>
        <label class="field cpw-f"><span>Price / cyl (₱)</span><input id="m-price" type="text" inputmode="decimal" placeholder="1055.00" value="${esc(ui.price)}"></label>
      </div>
      ${selectedZone ? `<div class="cpw-zone small muted">Zone: <b>${esc(selectedZone)}</b></div>` : ''}
      <div class="cpw-photo">
        ${ui.noCamera
          ? `<input id="m-photo-name" type="text" placeholder="Photo filename" value="${esc(ui.photoName)}" class="cpw-f-sm">`
          : `<input id="m-photo" type="file" accept="image/*" capture="environment">${ui.photoUrl ? `<span class="small">${esc(ui.photoName)}</span>` : ''}`}
        <label class="toggle small"><input id="m-nocam" type="checkbox" ${ui.noCamera ? 'checked' : ''}> No camera</label>
      </div>
      ${ui.outlier ? `<div class="banner amber" role="alert">${esc(ui.outlier.message)}
          <div class="row" style="margin-top:6px"><button type="button" id="m-confirm" class="primary small">Yes, submit</button><button type="button" id="m-fix" class="small">Fix price</button></div></div>` : ''}
      ${ui.error ? `<div class="err" role="alert">${esc(ui.error)}</div>` : ''}
      <button type="button" id="m-submit" class="primary" ${ui.outlier ? 'disabled' : ''}>Submit reading</button>
    </div>
    </section>

    <details class="cpw-sec" id="m-due" ${ui.dueOpen ? 'open' : ''}><summary><h2>Still due this week</h2><span class="cpw-count">${due.length}</span></summary>
    <div class="scroll-box">
    ${due.length ? `<ul class="stack" style="list-style:none;padding:0;margin:0">${due.map(d => `<li class="row"><span aria-hidden="true">☐</span>
      <span class="grow">${esc(d.brand)} · ${esc(d.zone)}</span>
      <span class="small muted">${d.r ? `last ${daysSince(d.r.capturedAt, now)} days ago` : 'never'}</span></li>`).join('')}</ul>`
      : '<p class="muted small" style="margin:0">All tracked brands have a reading this week.</p>'}
    </div></details>

    <details class="cpw-sec" id="m-recent" ${ui.recentOpen ? 'open' : ''}><summary><h2>Recent readings</h2><span class="cpw-count">${recent.length}</span></summary>
    <div class="scroll-box"><table class="mini"><thead><tr><th>Brand</th><th>By</th><th class="num">Per cyl</th></tr></thead><tbody>
    ${recent.map(r => {
      const stale = isStaleReading(s, r, now);
      return `<tr class="${stale ? 'stale' : ''}"><td>${esc(r.brand)}${r.productBrand ? ` · ${esc(r.productBrand)}` : ''}<br><span class="small">${r.channelId ? esc(channelLabel(s, r.channelId)) + ' · ' : ''}${esc(r.zone)} · ${esc(s.skus.find(k => k.id === r.skuId)?.label ?? r.skuId)}</span></td>
        <td class="small">${esc(userName(s, r.capturedBy))}</td>
        <td class="num">${fmt(r.pricePerCyl)}<br><span class="small">${fmtDate(r.capturedAt)}${stale ? ` · <span class="pill grey">${daysSince(r.capturedAt, now)}d</span>` : ''}</span></td></tr>`;
    }).join('')}
    </tbody></table></div></details>
  </section>`;
}

function bind(root, ctx) {
  const rerender = () => render(root, { ...ctx, state: store.get() });
  const $ = id => root.querySelector('#' + id);
  const clearFlags = () => { ui.error = ''; ui.outlier = null; };

  $('m-due').ontoggle = e => { ui.dueOpen = e.target.open; };
  $('m-recent').ontoggle = e => { ui.recentOpen = e.target.open; };
  $('m-channel').onchange = e => { ui.channelId = e.target.value; clearFlags(); rerender(); };
  $('m-pbrand').oninput = e => { ui.productBrand = e.target.value; };
  $('m-brand').onchange = e => { ui.brand = e.target.value; clearFlags(); rerender(); };
  if ($('m-brand-other')) $('m-brand-other').oninput = e => { ui.brandOther = e.target.value; clearFlags(); };
  $('m-sku').onchange = e => { ui.skuId = e.target.value; clearFlags(); rerender(); };
  $('m-price').oninput = e => { ui.price = e.target.value; if (ui.outlier || ui.error) { clearFlags(); rerender(); } };
  $('m-nocam').onchange = e => { ui.noCamera = e.target.checked; ui.photoUrl = null; ui.photoName = ''; rerender(); };
  if ($('m-photo')) $('m-photo').onchange = e => {
    const f = e.target.files[0];
    if (ui.photoUrl) URL.revokeObjectURL(ui.photoUrl);
    ui.photoUrl = f ? URL.createObjectURL(f) : null;
    ui.photoName = f ? f.name : '';
    ui.error = '';
    rerender();
  };
  if ($('m-photo-name')) $('m-photo-name').oninput = e => { ui.photoName = e.target.value; };
  if ($('m-fix')) $('m-fix').onclick = () => { ui.outlier = null; rerender(); root.querySelector('#m-price')?.focus(); };
  if ($('m-confirm')) $('m-confirm').onclick = () => submit(ctx, true).then(rerender);
  $('m-submit').onclick = () => submit(ctx, false).then(rerender);
}

async function submit({ user }, confirmed) {
  const s = store.get();
  const brand = (ui.brand === '__other' ? ui.brandOther : ui.brand).trim();
  const price = toCentavos(ui.price);
  ui.error = '';
  if (!ui.channelId) { ui.error = 'Choose a channel'; return; }
  if (!brand) { ui.error = 'Choose a partner (competitor)'; return; }
  if (!price || price <= 0) { ui.error = 'Enter the price per cylinder'; return; }
  const photo = ui.noCamera ? ui.photoName.trim() : ui.photoUrl;
  if (!photo) { ui.error = ui.noCamera ? 'Enter the photo filename' : 'Attach a photo of the price'; return; }

  const zone = zoneForBrand(s, brand) || '—';

  const last = newestReading(s, { zone, skuId: ui.skuId, brand });
  if (last && !confirmed) {
    const diff = (price - last.pricePerCyl) / last.pricePerCyl;
    if (Math.abs(diff) > 0.10) {
      ui.outlier = { message: `This is ${Math.round(Math.abs(diff) * 100)}% ${diff > 0 ? 'higher' : 'lower'} than the last ${last.brand} reading (${fmt(last.pricePerCyl)} on ${fmtDate(last.capturedAt)}). Correct?` };
      return;
    }
  }

  const id = store.uid('cr');
  const reading = {
    id, brand, zone, channelId: ui.channelId, productBrand: ui.productBrand.trim() || null, skuId: ui.skuId, pricePerCyl: price,
    capturedAt: new Date().toISOString(), capturedBy: user.id,
    photoUrl: ui.noCamera ? ui.photoName.trim() : ui.photoUrl, photoName: ui.photoName || null,
    outlierConfirmed: !!confirmed,
  };
  await store.commit({
    action: 'READING_CAPTURED', entity: 'competitorReading', entityId: id, field: 'pricePerCyl',
    before: last ? last.pricePerCyl : null, after: price,
  }, d => { d.competitorReadings.push(reading); });

  Object.assign(ui, { productBrand: '', brand: '', brandOther: '', price: '', photoUrl: null, photoName: '', outlier: null, error: '' });
  toast('Reading captured');
}
