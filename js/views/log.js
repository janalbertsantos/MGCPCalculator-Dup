// Log — manager. Read-only tabs over the one append-only event array.
// There is no "add log entry" control anywhere: events are written only by store.commit().

import { fmt } from '../money.js';
import { esc, options } from '../ui.js';
import { byId, skuLabel, channelLabel, userName, fmtDate, fmtDateTime, currentPublication, allBoardPrices } from '../pricing.js';

const DAY = 86400000;
const ui = { tab: 'week' };

const ACTION_LABEL = {
  DRAFT: 'Draft', SIMULATE: 'Simulate', APPROVE: 'Approve', PUBLISH: 'Publish', QUOTE_SENT: 'Quote sent',
  REQUEST_LOWER: 'Price request', REQUEST_DECIDED: 'Request decided', READING_CAPTURED: 'Reading captured',
  BOARD_ACKNOWLEDGED: 'PL notice acknowledged', ACCOUNTS_IMPORTED: 'Clients imported', CONFIG_CHANGED: 'Configuration', PRICE_LIST_ISSUED: 'Price list issued', CLIENT_TERMS_SAVED: 'Client terms saved',
  PL_EMAIL_SENT: 'Price list emailed',
};

export function describeEvent(s, ev) {
  const a = ev.after || {};
  switch (ev.action) {
    case 'DRAFT': return `Proposal drafted. Objective: ${ev.objective}. Changes: ${a.cause ?? '—'}`;
    case 'SIMULATE': return `Simulated ${a.cause}. Estimated monthly impact ${fmt(a.monthlyImpact)} (${a.excludedCount} accounts without volume excluded); ${a.newlyBelowFloor} accounts newly below floor. No prices changed.`;
    case 'APPROVE': return `Approved. Instructed by ${userName(s, ev.instructedBy)}, verified by ${userName(s, ev.verifiedBy)}.`;
    case 'PUBLISH': return `Cause: ${a.cause}. Price list v${a.version} published.`;
    case 'QUOTE_SENT': return `${byId(s.accounts, ev.entityId)?.name ?? ev.entityId}: ${skuLabel(s, a.skuId)} × ${a.qty} quoted at ${fmt(a.grossPerCyl)}/cyl (${fmt(a.grossTotal)})`;
    case 'REQUEST_LOWER': return `${byId(s.accounts, ev.entityId)?.name ?? ev.entityId}: lower price requested, ${fmt(ev.before)} → ${fmt(ev.after)}/cyl`;
    case 'REQUEST_DECIDED': return `${byId(s.accounts, a.accountId)?.name ?? 'Walk-in'}: request ${a.status}. Reason: ${a.decisionReason}`;
    case 'READING_CAPTURED': {
      const r = s.competitorReadings.find(x => x.id === ev.entityId);
      return r ? `${r.brand}, ${r.zone}, ${skuLabel(s, r.skuId)}: ${fmt(ev.after)}${ev.before != null ? ` (previous ${fmt(ev.before)})` : ''}` : `Reading ${fmt(ev.after)}`;
    }
    case 'BOARD_ACKNOWLEDGED': return `${channelLabel(s, a.channelId)} price list v${a.boardVersion} acknowledged`;
    case 'ACCOUNTS_IMPORTED': return `Clients imported from ${a.file}: ${a.added} added, ${a.updated} updated${a.removed ? `, ${a.removed} removed (replace)` : ''}, ${a.skipped} rows skipped`;
    case 'CONFIG_CHANGED': return `${({ users: 'Users', channels: 'Channels', skus: 'Products', zones: 'Price watch zones', channelProducts: 'Channel products', access: 'Price room access' })[ev.entity] ?? 'Configuration'} changed — ${a.summary}`;
    case 'CLIENT_TERMS_SAVED': return `Client terms updated on ${a.count} client${a.count === 1 ? '' : 's'} — ${a.summary}`;
    case 'PRICE_LIST_ISSUED': return `${byId(s.accounts, a.accountId)?.name ?? 'Walk-in'}: price list ${a.mode === 'print' ? 'printed' : a.mode === 'email' ? `emailed to ${a.email}` : 'saved as PDF'} — ${(a.lines || []).map(l => `${skuLabel(s, l.skuId)} ${fmt(l.grossPerCyl)}${l.qty ? ` × ${l.qty}` : ''}`).join(', ')}`;
    case 'PL_EMAIL_SENT': return `${byId(s.accounts, a.accountId)?.name ?? 'Walk-in'}: price list v${a.version} emailed to ${a.email}`;
    default: return ev.action;
  }
}

export function eventTouchesAccount(ev, accountId) {
  return ev.entityId === accountId || ev.after?.accountId === accountId || (ev.after?.accountIds || []).includes(accountId);
}

function eventItem(s, ev, { showActor = true } = {}) {
  const review = ev.action === 'PUBLISH' && ev.after?.review?.length
    ? `<ul class="small">${ev.after.review.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : '';
  return `<li><div class="small muted">${fmtDateTime(ev.timestamp)} · <b>${esc(ACTION_LABEL[ev.action])}</b>${showActor ? ` · ${esc(userName(s, ev.actorId))}` : ''}${ev.snapshotHash ? ` · hash <code>${esc(ev.snapshotHash.slice(0, 8))}</code>` : ''}</div>
    <div>${esc(describeEvent(s, ev))}</div>${review}</li>`;
}

export function render(root, { state: s }) {
  const tabs = [['week', 'Issues'], ['channels', 'Channels'], ['clients', 'Clients'], ['competitors', 'Competitors'], ['actors', 'Users'], ['products', 'Products']];
  let body = '';
  const events = [...s.events].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  if (ui.tab === 'week') {
    const since = Date.now() - 7 * DAY;
    const week = events.filter(e => new Date(e.timestamp).getTime() >= since);
    const groups = new Map();
    for (const e of week) {
      const k = e.proposalId || `single_${e.id}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    body = week.length ? [...groups.entries()].map(([k, evs]) => {
      if (!k.startsWith('single_')) {
        const first = evs[evs.length - 1];
        const pub = evs.find(e => e.action === 'PUBLISH');
        const cause = pub?.after?.cause ?? evs.find(e => e.after?.cause)?.after?.cause ?? '—';
        return `<div class="card" style="margin-bottom:12px"><div><b>Cause: ${esc(cause)}</b></div>
          <div class="small muted">Proposal ${esc(k.slice(-8))} · objective: ${esc(first.objective ?? '—')} · ${pub ? `published as v${pub.after.version}` : 'not published'}</div>
          <ul class="timeline" style="margin-top:10px">${evs.map(e => eventItem(s, e)).join('')}</ul></div>`;
      }
      return `<ul class="timeline" style="margin:0 0 12px 4px">${eventItem(s, evs[0])}</ul>`;
    }).join('') : '<p class="muted">Nothing logged in the last 7 days.</p>';
  }

  if (ui.tab === 'channels') {
    const byChannel = new Map();
    for (const e of events) {
      const chId = e.after?.channelId ?? (e.entityId && byId(s.channels, e.entityId) ? e.entityId : null);
      if (!chId) continue;
      if (!byChannel.has(chId)) byChannel.set(chId, []);
      byChannel.get(chId).push(e);
    }
    body = byChannel.size ? [...byChannel.entries()].map(([chId, evs]) => `<details class="card" style="margin-bottom:10px">
      <summary>${esc(channelLabel(s, chId))} <span class="muted small" style="margin-left:8px">${evs.length} events</span></summary>
      <ul class="timeline">${evs.map(e => eventItem(s, e)).join('')}</ul></details>`).join('')
      : '<p class="muted">No channel-related events yet.</p>';
  }

  if (ui.tab === 'clients') {
    const byClient = new Map();
    for (const e of events) {
      const accId = e.entityId && byId(s.accounts, e.entityId) ? e.entityId
        : e.after?.accountId && byId(s.accounts, e.after.accountId) ? e.after.accountId : null;
      if (!accId) continue;
      if (!byClient.has(accId)) byClient.set(accId, []);
      byClient.get(accId).push(e);
    }
    const sorted = [...byClient.entries()].sort((a, b) => {
      const na = byId(s.accounts, a[0])?.name ?? '';
      const nb = byId(s.accounts, b[0])?.name ?? '';
      return na.localeCompare(nb);
    });
    body = sorted.length ? sorted.map(([accId, evs]) => {
      const acc = byId(s.accounts, accId);
      return `<details class="card" style="margin-bottom:10px">
      <summary>${esc(acc?.name ?? accId)} <span class="muted small" style="margin-left:8px">${esc(channelLabel(s, acc?.channelId))} · ${esc(acc?.zone ?? '—')} · ${evs.length} events</span></summary>
      <ul class="timeline">${evs.map(e => eventItem(s, e)).join('')}</ul></details>`;
    }).join('') : '<p class="muted">No client-related events yet.</p>';
  }

  if (ui.tab === 'competitors') {
    const byBrand = new Map();
    for (const e of events) {
      if (e.action !== 'READING_CAPTURED') continue;
      const r = s.competitorReadings.find(x => x.id === e.entityId);
      const brand = r?.brand ?? 'Unknown';
      if (!byBrand.has(brand)) byBrand.set(brand, []);
      byBrand.get(brand).push(e);
    }
    body = byBrand.size ? [...byBrand.entries()].map(([brand, evs]) => `<details class="card" style="margin-bottom:10px">
      <summary>${esc(brand)} <span class="muted small" style="margin-left:8px">${evs.length} readings</span></summary>
      <ul class="timeline">${evs.map(e => eventItem(s, e)).join('')}</ul></details>`).join('')
      : '<p class="muted">No competitor readings logged yet.</p>';
  }

  if (ui.tab === 'actors') {
    const byActor = new Map();
    for (const e of events) {
      if (!byActor.has(e.actorId)) byActor.set(e.actorId, []);
      byActor.get(e.actorId).push(e);
    }
    body = byActor.size ? [...byActor.entries()].map(([actor, evs]) => `<details class="card" style="margin-bottom:10px">
      <summary>${esc(userName(s, actor))} <span class="muted small" style="margin-left:8px">${esc(byId(s.users, actor)?.role ?? '')} · ${evs.length} events</span></summary>
      <ul class="timeline">${evs.map(e => eventItem(s, e, { showActor: false })).join('')}</ul></details>`).join('')
      : '<p class="muted">No events yet.</p>';
  }

  if (ui.tab === 'products') {
    const bySku = new Map();
    for (const e of events) {
      const skuId = e.after?.skuId ?? (e.entity === 'skus' ? e.entityId : null);
      if (!skuId) continue;
      if (!bySku.has(skuId)) bySku.set(skuId, []);
      bySku.get(skuId).push(e);
    }
    const versions = [...s.publications].sort((a, b) => b.version - a.version);
    for (const pub of versions) {
      const prices = pub.prices ?? (pub.version === currentPublication(s)?.version ? allBoardPrices(s) : null);
      if (!prices) continue;
      for (const [chId, rows] of Object.entries(prices)) {
        for (const r of rows) {
          if (!bySku.has(r.skuId)) bySku.set(r.skuId, []);
        }
      }
    }
    body = bySku.size || s.skus.length ? s.skus.map(sku => {
      const evs = bySku.get(sku.id) || [];
      const priceHistory = versions.map(pub => {
        const prices = pub.prices ?? (pub.version === currentPublication(s)?.version ? allBoardPrices(s) : null);
        if (!prices) return null;
        const chPrices = s.channels.map(c => {
          const r = prices[c.id]?.find(x => x.skuId === sku.id);
          return r ? fmt(r.grossPerCyl) : '—';
        });
        return `<tr><td class="nowrap">v${pub.version}<br><span class="small muted">${fmtDate(pub.publishedAt)}</span></td>${chPrices.map(p => `<td class="num">${p}</td>`).join('')}</tr>`;
      }).filter(Boolean);
      return `<details class="card" style="margin-bottom:10px">
      <summary>${esc(sku.label)} <span class="muted small" style="margin-left:8px">${esc(sku.id)} · ${evs.length} events · ${priceHistory.length} versions</span></summary>
      ${priceHistory.length ? `<div class="table-wrap"><table><thead><tr><th>Version</th>${s.channels.map(c => `<th class="num">${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${priceHistory.join('')}</tbody></table></div>` : ''}
      ${evs.length ? `<ul class="timeline" style="margin-top:10px">${evs.map(e => eventItem(s, e)).join('')}</ul>` : ''}</details>`;
    }).join('') : '<p class="muted">No product events yet.</p>';
  }

  root.innerHTML = `<section class="page wide"><h1>Log</h1>
    <div class="tabs">${tabs.map(([k, l]) => `<button type="button" data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
    ${body}</section>`;

  root.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { ui.tab = b.dataset.tab; render(root, { state: s }); });
}
