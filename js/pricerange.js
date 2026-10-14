// Shared price-range filter (min / max, pesos per cylinder, VAT incl.) used by every Price room board.
// Two draggable handles over the span of prices on the board, plus typed Min / Max for exact values.

import { toCentavos, toInput } from './money.js';

export const range = { min: '', max: '' };

const bounds = () => ({ lo: toCentavos(range.min), hi: toCentavos(range.max) });

export function rangeActive() {
  const { lo, hi } = bounds();
  return lo != null || hi != null;
}

export function inRange(centavos) {
  if (centavos == null) return false;
  const { lo, hi } = bounds();
  return (lo == null || centavos >= lo) && (hi == null || centavos <= hi);
}

const STEP = 10;

// Slider span in whole pesos, rounded out to STEP so every price on the board sits inside it.
function domain(prices) {
  const list = (prices || []).filter(p => p != null && Number.isFinite(p));
  if (!list.length) return null;
  let lo = Math.floor(Math.min(...list) / 100 / STEP) * STEP;
  let hi = Math.ceil(Math.max(...list) / 100 / STEP) * STEP;
  const { lo: a, hi: b } = bounds();
  if (a != null) lo = Math.min(lo, Math.floor(a / 100 / STEP) * STEP);
  if (b != null) hi = Math.max(hi, Math.ceil(b / 100 / STEP) * STEP);
  if (hi <= lo) hi = lo + STEP;
  return { lo, hi };
}

const peso = n => '₱' + Number(n).toLocaleString('en-PH');

export function rangeBar(shown, total, noun, prices, unit = 'per cyl, VAT incl.') {
  const on = rangeActive();
  const d = domain(prices);
  const { lo: a, hi: b } = bounds();
  const vMin = d ? (a != null ? Math.max(d.lo, Math.round(a / 100)) : d.lo) : 0;
  const vMax = d ? (b != null ? Math.min(d.hi, Math.round(b / 100)) : d.hi) : 0;
  return `<div class="range-bar">
    <span class="range-label">Price range</span>
    ${d ? `<div class="dual" id="rg-dual" data-lo="${d.lo}" data-hi="${d.hi}">
      <div class="dual-track"><div class="dual-fill"></div></div>
      <input type="range" id="rg-s-min" min="${d.lo}" max="${d.hi}" step="${STEP}" value="${vMin}" aria-label="Minimum price">
      <input type="range" id="rg-s-max" min="${d.lo}" max="${d.hi}" step="${STEP}" value="${vMax}" aria-label="Maximum price">
      <div class="dual-ends"><span>${peso(d.lo)}</span><span>${peso(d.hi)}</span></div>
    </div>` : ''}
    <span class="range-in"><span>₱</span><input id="rg-min" type="text" inputmode="decimal" placeholder="Min" value="${range.min}" aria-label="Minimum price per cylinder"></span>
    <span class="range-dash">–</span>
    <span class="range-in"><span>₱</span><input id="rg-max" type="text" inputmode="decimal" placeholder="Max" value="${range.max}" aria-label="Maximum price per cylinder"></span>
    <button type="button" id="rg-apply" class="small primary">Apply</button>
    ${on ? '<button type="button" id="rg-clear" class="small">Clear</button>' : ''}
    <span class="small muted range-note">${unit}${on ? ` · showing ${shown} of ${total} ${noun}` : ''}</span>
  </div>`;
}

export function bindRange(root, rerender) {
  const min = root.querySelector('#rg-min');
  const max = root.querySelector('#rg-max');
  if (!min || !max) return;
  const apply = () => {
    const lo = toCentavos(min.value), hi = toCentavos(max.value);
    range.min = lo == null ? '' : toInput(lo);
    range.max = hi == null ? '' : toInput(hi);
    if (lo != null && hi != null && lo > hi) [range.min, range.max] = [range.max, range.min];
    rerender();
  };
  root.querySelector('#rg-apply').onclick = apply;
  [min, max].forEach(i => i.onkeydown = e => { if (e.key === 'Enter') apply(); });
  const clear = root.querySelector('#rg-clear');
  if (clear) clear.onclick = () => { range.min = range.max = ''; rerender(); };

  const dual = root.querySelector('#rg-dual');
  if (!dual) return;
  const lo = +dual.dataset.lo, hi = +dual.dataset.hi;
  const sMin = root.querySelector('#rg-s-min'), sMax = root.querySelector('#rg-s-max');
  const fill = dual.querySelector('.dual-fill');
  const paint = () => {
    fill.style.left = ((+sMin.value - lo) / (hi - lo) * 100) + '%';
    fill.style.right = (100 - (+sMax.value - lo) / (hi - lo) * 100) + '%';
  };
  const live = e => {
    if (+sMin.value > +sMax.value) (e.target === sMin ? sMin : sMax).value = e.target === sMin ? sMax.value : sMin.value;
    min.value = +sMin.value > lo ? toInput(+sMin.value * 100) : '';
    max.value = +sMax.value < hi ? toInput(+sMax.value * 100) : '';
    paint();
  };
  [sMin, sMax].forEach(sl => { sl.oninput = live; sl.onchange = apply; });
  paint();
}
