// Who can do what in the Price room. 19 parts × 4 access levels, set per role and overridable per user
// (Configuration → Users). Roles come with the defaults below; edits are stored in state.accessRoles
// and state.users[i].access, and every change is logged.

export const LEVELS = ['None', 'View', 'Edit', 'Approve'];

export const PARTS = [
  { id: 'comp_board', group: 'Boards', label: 'Competitors board' },
  { id: 'comp_decision', group: 'Boards', label: 'Competitors board: Price decision column' },
  { id: 'channels_board', group: 'Boards', label: 'Channels board' },
  { id: 'history', group: 'Boards', label: 'Price History' },
  { id: 'notices', group: 'Boards', label: 'PL Notices' },
  { id: 'cp_price', group: 'Client Pricing', label: 'Current price column' },
  { id: 'cp_premiums', group: 'Client Pricing', label: 'Premiums (installation cost for ROI, credit risk / bad debts)' },
  { id: 'cp_supply', group: 'Client Pricing', label: 'Discounts: Supply only' },
  { id: 'cp_compete', group: 'Client Pricing', label: 'Discounts: Competition (dual supplier)' },
  { id: 'cp_cash', group: 'Client Pricing', label: 'Discounts: Cash / zero-rated (short term)' },
  { id: 'cp_list', group: 'Client Pricing', label: 'Client list and filters' },
  { id: 'mpl_cost', group: 'MPL calculator', label: 'Cost basis: acquisition and hauling' },
  { id: 'mpl_margin', group: 'MPL calculator', label: 'Margins per channel and product' },
  { id: 'mpl_buffer', group: 'MPL calculator', label: 'Buffers per channel' },
  { id: 'mpl_draft', group: 'MPL calculator', label: 'Draft and simulate a proposal' },
  { id: 'mpl_approve', group: 'MPL calculator', label: 'Review and approve a proposal' },
  { id: 'mpl_publish', group: 'MPL calculator', label: 'Publish a new price list version' },
  { id: 'appr_review', group: 'Approvals', label: '"Needs review" list' },
  { id: 'appr_requests', group: 'Approvals', label: 'Price requests (lower-price requests from sales)' },
];

// Order of columns: the numbers follow PARTS.
const row = (...n) => Object.fromEntries(PARTS.map((p, i) => [p.id, n[i]]));
export const ROLE_DEFAULTS = {
  seller:     row(1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0),
  accounting: row(0, 0, 1, 1, 0, 1, 2, 1, 1, 2, 1, 1, 0, 0, 0, 0, 0, 1, 0),
  manager:    row(2, 2, 1, 1, 1, 1, 2, 2, 2, 2, 1, 2, 2, 2, 2, 1, 1, 1, 2),
  admin:      row(3, 3, 1, 1, 1, 1, 3, 3, 3, 3, 1, 3, 3, 3, 3, 3, 3, 1, 3),
  viewer:     row(1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  messenger:  row(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
};
export const ACCESS_ROLES = ['seller', 'accounting', 'manager', 'admin', 'viewer'];
export const ROLE_LABEL = { seller: 'Sales Assistant', accounting: 'Accounting', manager: 'Manager', admin: 'Admin', viewer: 'Viewer', messenger: 'Messenger' };

// Level of one part for one user: their own override, else the role's setting, else the built-in default.
export function roleLevel(s, role, part) {
  return s?.accessRoles?.[role]?.[part] ?? ROLE_DEFAULTS[role]?.[part] ?? 0;
}
export function level(s, user, part) {
  if (!user) return 0;
  return user.access?.[part] ?? roleLevel(s, user.role, part);
}
export const can = (s, user, part, atLeast) => level(s, user, part) >= atLeast;
export const canView = (s, user, part) => level(s, user, part) >= 1;
export const canEdit = (s, user, part) => level(s, user, part) >= 2;
export const canApprove = (s, user, part) => level(s, user, part) >= 3;

// Price room tab → the part that decides whether it shows at all.
export const TAB_PART = { competitors: 'comp_board', channels: 'channels_board', grid: 'cp_list', history: 'history', notices: 'notices' };
export const MPL_PARTS = ['mpl_cost', 'mpl_margin', 'mpl_buffer', 'mpl_draft', 'mpl_approve', 'mpl_publish'];

export const canSeeTab = (s, user, tab) => canView(s, user, TAB_PART[tab]);
export const canSeeMpl = (s, user) => MPL_PARTS.some(p => canView(s, user, p));
export const canSeeApprovals = (s, user) => canView(s, user, 'appr_review') || canView(s, user, 'appr_requests');
export const canSeePriceRoom = (s, user) => Object.keys(TAB_PART).some(t => canSeeTab(s, user, t)) || canSeeMpl(s, user) || canSeeApprovals(s, user);
