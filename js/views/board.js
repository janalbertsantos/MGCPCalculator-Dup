// The Board — one page per channel audience. Only that channel's SKUs and prices.

import * as store from '../store.js';
import { fmt } from '../money.js';
import { esc, toast, stamp } from '../ui.js';
import { printDoc, savePdf, slug } from '../pricedoc.js';
import { byId, boardPrices, currentPublication, boardIsStale, userChannels, fmtDate, fmtDateTime } from '../pricing.js';

export function render(root, ctx) {
  const { state: s, user, route } = ctx;
  const channelId = route.args[0];
  if (!channelId) { root.innerHTML = index(s, user); return; }

  const channel = byId(s.channels, channelId);
  if (!channel) { root.innerHTML = `<section class="page narrow"><h1>No such price list</h1><p><a href="#/board">All price lists</a></p></section>`; return; }

  const pub = currentPublication(s);
  const askedVersion = route.query.v ? parseInt(route.query.v, 10) : pub.version;
  const shownPub = s.publications.find(p => p.version === askedVersion) || pub;
  const superseded = shownPub.version < pub.version;
  const rows = superseded ? shownPub.prices?.[channelId] ?? null : boardPrices(s, channelId);
  const ack = s.acknowledgments.find(a => a.userId === user.id && a.boardVersion === pub.version && a.channelId === channelId);

  root.innerHTML = `<section class="page" style="max-width:760px">
    ${superseded ? `<div class="banner amber">This is price list v${shownPub.version}, superseded. <a href="#/board/${esc(channelId)}">Open the current price list (v${pub.version})</a></div>` : ''}
    ${!superseded && boardIsStale(s) ? '<div class="banner red">Cost basis has changed since this price list was published — republish before quoting.</div>' : ''}
    <div class="board-head">
      <div><div class="muted">${esc(channel.audience)} price list</div><h1 style="margin:2px 0 0">${esc(channel.label)}</h1></div>
      ${stamp(shownPub.version, fmtDate(shownPub.publishedAt), { size: 'lg', note: superseded ? 'Superseded' : '' })}
    </div>
    <hr class="hr">
    ${rows ? `<div class="table-wrap"><table>
      <thead><tr><th>Product</th><th class="num">Per kg, net</th><th class="num">Per cylinder, net</th><th class="num">Per cylinder, VAT incl.</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td><b>${esc(r.label)}</b><br><span class="small muted">${r.contentKg} kg</span></td>
        <td class="num">${fmt(r.netPerKg)}</td><td class="num">${fmt(r.netPerCyl)}</td><td class="num"><b>${fmt(r.grossPerCyl)}</b></td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">Prices for this version were not captured in the prototype seed.</p>'}
    ${superseded ? '' : `<div class="row no-print" style="margin-top:16px">
      ${ack ? `<span class="pill green">Seen ${esc(fmtDateTime(ack.acknowledgedAt))}</span>`
        : '<button type="button" id="b-ack" class="primary">Acknowledge</button>'}
      <button type="button" id="b-print">Print</button>
      <button type="button" id="b-save">Save</button></div>`}
  </section>`;

  const ackBtn = root.querySelector('#b-ack');
  if (ackBtn) ackBtn.onclick = async () => {
    await store.commit({
      action: 'BOARD_ACKNOWLEDGED', entity: 'board', entityId: channelId, field: 'boardVersion', after: { boardVersion: pub.version, channelId },
    }, (d, ev) => { d.acknowledgments.push({ userId: user.id, boardVersion: pub.version, channelId, acknowledgedAt: ev.timestamp }); });
    toast('Marked seen');
  };
  const printBtn = root.querySelector('#b-print');
  if (printBtn) printBtn.onclick = () => printDoc(boardDoc(s, user, channel, pub, rows));
  const saveBtn = root.querySelector('#b-save');
  if (saveBtn) saveBtn.onclick = async () => {
    await savePdf(boardDoc(s, user, channel, pub, rows), `MGC-price-list-${slug(channel.label)}-v${pub.version}.pdf`);
    toast('Price list saved');
  };
}

function index(s, user) {
  const pub = currentPublication(s);
  const mine = s.channels.filter(c => userChannels(s, user).includes(c.id));
  return `<section class="page narrow"><div class="page-head"><h1>Price lists</h1>${stamp(pub.version, fmtDate(pub.publishedAt))}</div>
    <ul class="stack" style="list-style:none;padding:0">${mine.map(c => `<li><a class="btn" style="width:100%;justify-content:space-between" href="#/board/${esc(c.id)}">
      <span>${esc(c.label)}</span><span class="muted small">${esc(c.audience)}</span></a></li>`).join('')}</ul></section>`;
}

// Same short bond template as the Quote desk; the version stamp is printed on every copy.
function boardDoc(s, user, channel, pub, rows) {
  return {
    title: 'Price list', docNo: `Price list v${pub.version} · ${channel.id}`,
    customer: channel.label, subtitle: `${channel.audience} price list`,
    version: pub.version, effective: fmtDate(pub.publishedAt), issued: fmtDateTime(new Date()), validUntil: null,
    issuedBy: user.name, vatRate: s.settings.vatRate, ref: (pub.snapshotHash || '').slice(0, 8),
    rows: rows.map(r => ({ label: r.label, contentKg: r.contentKg, netPerKg: r.netPerKg, grossPerCyl: r.grossPerCyl })),
    total: null,
  };
}
