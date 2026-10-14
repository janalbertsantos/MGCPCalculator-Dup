// MGC LPG Pricing Matrix, 2026-10-13. Margins in centavos per kg. skuId -> margin.
export const COST_TOTAL = 8625; // Acq + hauling per kg
export const MARGINS = {
  DEALER:        { '50KG_A': 1700, '22KG_A': 1800, '11KG_MGAS': 1800, '11KG_SULIT': 1250, MINI9: 1805, '5KG_SULIT': 2005, '2.7KG': 2300, '2.7KG_SULIT': 2800 },
  COBANKIAT:     { '50KG_A': 1175, '22KG_A': 1175, '11KG_MGAS': 1175, '11KG_SULIT': 675 },
  COMMERCIAL:    { '50KG_A': 3400, '22KG_A': 4800, '22KG_FL_A': 5000, '11KG_MGAS': 4950, '11KG_SULIT': 4469, MINI9: 2483, '5KG_SULIT': 4350, '2.7KG': 7560 },
  RETAIL_OUTLET: { '11KG_MGAS': 2750, '11KG_SULIT': 2200, '2.7KG': 3400, '2.7KG_SULIT': 3700 },
  MGSA:          { '50KG_A': 1100, '50KG_B': 1100, '50KG_C': 1100, '22KG_A': 1100, '22KG_B': 1100, '11KG_MGAS': 1100, '11KG_SULIT': 1100, '2.7KG': 2000, '2.7KG_SULIT': 2650 },
  END_USER:      { '50KG_A': 3400, '22KG_A': 5200, '11KG_MGAS': 4400, '11KG_SULIT': 3600, MINI9: 4000, '5KG_SULIT': 6320, '2.7KG': 6100, '2.7KG_SULIT': 5900 },
};
// Buffer per kg: channel default (the MGas line) plus per-product exceptions.
// CODO pick-up uses the Dealer margins with its own buffers (-0.50 MGas line, -1.00 Sulit), which gives the CODO block's MPLs.
MARGINS.CODO = { ...MARGINS.DEALER };
export const BUFFERS = {
  CODO: { def: -50, sku: { '11KG_SULIT': -100, '2.7KG_SULIT': -100 } },
  DEALER: { def: 0 }, COBANKIAT: { def: 0 }, COMMERCIAL: { def: 0 }, MGSA: { def: -25 },
  RETAIL_OUTLET: { def: 0, sku: { '11KG_SULIT': -50 } },
  END_USER: { def: 25, sku: { '11KG_SULIT': -125, '2.7KG_SULIT': -125 } },
};

// Class B and C cylinders: Dealer, CODO, Commercial and End User keep the Class A margin and buffer per CYLINDER,
// so per kg it is the Class A figure scaled by content. (MGSA is per kg and lists its classes above.)
const KG = { '50KG_A': 50, '50KG_B': 47, '50KG_C': 45, '22KG_A': 22, '22KG_B': 20 };
const CLASSES = {
  DEALER: { '50KG_B': '50KG_A', '50KG_C': '50KG_A', '22KG_B': '22KG_A' },
  CODO: { '50KG_B': '50KG_A', '50KG_C': '50KG_A', '22KG_B': '22KG_A' },
  COMMERCIAL: { '50KG_B': '50KG_A', '50KG_C': '50KG_A', '22KG_B': '22KG_A' },
  END_USER: { '50KG_B': '50KG_A', '50KG_C': '50KG_A' },
};
for (const [ch, map] of Object.entries(CLASSES)) {
  for (const [sku, a] of Object.entries(map)) {
    const scale = v => Math.round(v * KG[a] / KG[sku]);
    MARGINS[ch][sku] = scale(MARGINS[ch][a]);
    const bufA = BUFFERS[ch].sku?.[a] ?? BUFFERS[ch].def;
    if (bufA) (BUFFERS[ch].sku ||= {})[sku] = scale(bufA);
  }
}

// Volume pricing, centavos per CYLINDER. The MPL falls by `step` at each volume tier after the first one priced at the full MPL
// (`from` = index of that tier). Retail Outlet also adds `zoneAdd` per delivery zone step (Zone 2 = 1 step, Zone 3 = 2).
// Commercial is not offered below the 3 - 5 tier on 11 kg and 2.7 kg, so those start at index 1.
export const VOLUME = [
  {
    channelId: 'COMMERCIAL',
    tiers: [{ id: '1-2', label: '1 - 2' }, { id: '3-5', label: '3 - 5' }, { id: '6-10', label: '6 - 10' }, { id: '11+', label: '11 & up' }],
    skus: {
      '50KG_A': { step: 7500, from: 0 }, '50KG_B': { step: 7500, from: 0 }, '50KG_C': { step: 7500, from: 0 },
      '22KG_A': { step: 1500, from: 0 }, '22KG_B': { step: 1500, from: 0 }, '22KG_FL_A': { step: 1500, from: 0 },
      '11KG_MGAS': { step: 1000, from: 1 }, '11KG_SULIT': { step: 1000, from: 1 }, '2.7KG': { step: 400, from: 1 },
    },
  },
  {
    channelId: 'RETAIL_OUTLET',
    tiers: [{ id: '3-5', label: '3 - 5' }, { id: '6-10', label: '6 - 10' }, { id: '11-25', label: '11 - 25' }, { id: '26-50', label: '26 - 50' }, { id: '51+', label: '51 & up' }],
    zones: [{ id: 'Z1', label: 'Zone 1', note: 'up to 30 km' }, { id: 'Z2', label: 'Zone 2', note: '30.1 to 40 km' }, { id: 'Z3', label: 'Zone 3', note: '40 to 60 km' }],
    skus: {
      '11KG_MGAS': { step: 500, from: 0, zoneAdd: 1500 }, '11KG_SULIT': { step: 500, from: 0, zoneAdd: 1500 },
      '2.7KG': { step: 300, from: 0, zoneAdd: 1000 }, '2.7KG_SULIT': { step: 300, from: 0, zoneAdd: 1000 },
    },
  },
];
