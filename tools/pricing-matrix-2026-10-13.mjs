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
