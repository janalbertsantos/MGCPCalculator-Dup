// Hash router. Roles are enforced by not rendering the route at all:
// a disallowed route never loads or runs its view module.

import * as store from './store.js';
import { userChannels } from './pricing.js';

const loaders = {
  quote: () => import('./views/quote.js'),
  priceroom: () => import('./views/priceroom.js'),
  market: () => import('./views/market.js'),
  board: () => import('./views/board.js'),
  log: () => import('./views/log.js'),
  config: () => import('./views/config.js'),
};

export function parse(hash = location.hash) {
  const h = hash.replace(/^#\/?/, '');
  const [path, qs = ''] = h.split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || '', args: parts.slice(1), query: Object.fromEntries(new URLSearchParams(qs)) };
}

export function canAccess(s, user, route) {
  if (!user) return false;
  const role = user.role;
  switch (route.name) {
    case 'quote': return role === 'seller';
    case 'priceroom': return role === 'manager' || role === 'admin';
    case 'log': return role === 'admin';
    case 'config': return role === 'admin' || role === 'manager' || role === 'seller';
    case 'market': return true;
    case 'board': {
      if (role === 'messenger') return false;
      if (!route.args[0]) return true; // board index lists only reachable boards
      return userChannels(s, user).includes(route.args[0]);
    }
    default: return false;
  }
}

// Configuration sub-menu: shown under "Configuration" in the top bar.
export const configTabs = s => [['users', 'Users'], ['channels', `Channels (${s.channels.length})`], ['zones', `Zones (${s.zones.length})`],
  ['clients', `Clients (${s.accounts.length})`], ['competitors', `Competitors (${s.trackedBrands.length})`], ['products', `Products (${s.skus.length})`]];

export const priceRoomTabs = [['competitors', 'Competitors board'], ['channels', 'Channels board'], ['grid', 'Client Pricing'], ['history', 'Price History'], ['notices', 'PL Notices']];

export function navFor(s, user) {
  const items = [];
  if (user.role === 'seller') items.push(['#/quote', 'Quote desk']);
  if (user.role === 'manager' || user.role === 'admin') items.push(['#/priceroom', 'Price room']);
  items.push(['#/market', 'Price Watch']);
  if (user.role !== 'messenger') items.push(['#/board', 'Price lists']);
  if (user.role === 'admin') items.push(['#/log', 'Log']);
  if (user.role === 'admin' || user.role === 'manager' || user.role === 'seller') items.push(['#/config', 'Configuration']);
  return items;
}

export function defaultHash(s, user) {
  if (user.role === 'seller') return '#/quote';
  if (user.role === 'manager' || user.role === 'admin') return '#/priceroom';
  if (user.role === 'messenger') return '#/market';
  const ch = userChannels(s, user)[0];
  return ch ? `#/board/${ch}` : '#/board';
}

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

let root = null;
let onRender = null;
let token = 0;

export async function render() {
  const my = ++token;
  const s = store.get();
  const user = store.currentUser();
  const route = parse();
  if (!route.name) { location.replace(defaultHash(s, user)); return; }
  if (onRender) onRender(route, user);

  if (!loaders[route.name] || !canAccess(s, user, route)) {
    root.innerHTML = `<section class="page narrow"><h1>Not available</h1>
      <p>This screen is not available to the ${user.role} role.</p>
      <p><a class="btn" href="${defaultHash(s, user)}">Go to your screen</a></p></section>`;
    return;
  }
  const mod = await loaders[route.name]();
  if (my !== token) return;
  mod.render(root, { state: s, user, route });
}

export function start(el, renderHook) {
  root = el;
  onRender = renderHook;
  window.addEventListener('hashchange', render);
  store.subscribe(render);
  render();
}
