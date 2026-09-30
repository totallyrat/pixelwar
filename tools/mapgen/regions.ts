// Hand-authored strategic resource regions: [centerLon, centerLat, radiusLon, radiusLat]
// Roughly follows the world's major real oil / uranium producing basins.

export const OIL_REGIONS: [number, number, number, number][] = [
  [49, 27, 8, 6],        // Persian Gulf (Saudi east, Kuwait, Iraq south, Iran SW, Qatar, UAE)
  [44, 35.5, 2.5, 2],    // Kirkuk
  [56.5, 21, 3, 3],      // Oman
  [73, 61, 10, 5],       // West Siberia
  [53, 54, 5, 3],        // Volga-Ural
  [52, 46, 4, 2.5],      // Caspian / Atyrau
  [49.8, 40.4, 1.5, 1],  // Baku
  [56, 39, 3, 2],        // Turkmenistan
  [-93, 30, 5, 2.5],     // US Gulf coast
  [-102.5, 31.8, 2.5, 2],// Permian basin
  [-103, 48, 2, 1.5],    // Bakken
  [-93, 18.5, 3, 1.5],   // Campeche / Tabasco
  [-150, 70, 5, 1.2],    // Alaska North Slope
  [-113, 56, 4, 3],      // Alberta oil sands
  [-66, 8.5, 5, 2],      // Orinoco belt
  [-71.5, 10, 1.5, 1.5], // Maracaibo
  [-73, 5, 2, 2],        // Colombia
  [-76.5, -1, 1.5, 1.5], // Ecuador / Peru Amazon
  [-41, -22, 2, 1.2],    // Campos basin coast
  [-69, -38.5, 2, 2],    // Neuquen / Vaca Muerta
  [6.5, 5, 2.5, 1.5],    // Niger delta
  [13, -7, 1.5, 2],      // Angola
  [20, 29, 5, 3],        // Libya (Sirte)
  [6, 31, 4, 3],         // Algeria (Hassi Messaoud)
  [29, 28, 2, 2],        // Egypt Western Desert
  [30, 10, 2.5, 2],      // Sudan / South Sudan
  [6, 59, 2, 2],         // Norway coast
  [-2.5, 57.3, 1, 1],    // Aberdeen
  [125, 46.5, 2, 1.5],   // Daqing
  [84, 40, 5, 2],        // Tarim
  [101.5, 1, 2, 2],      // Sumatra
  [115, 1, 3, 2.5],      // Borneo
  [143, 52, 1, 2],       // Sakhalin
  [40, 35, 2, 1.5],      // Syria / Deir ez-Zor
  [120.5, -27, 2, 2],    // Western Australia (minor)
];

export const URANIUM_REGIONS: [number, number, number, number][] = [
  [67, 44, 6, 3],        // Kazakhstan (Chu-Sarysu, Syrdarya)
  [-106, 58, 4, 2],      // Athabasca basin
  [136.9, -30.4, 2.5, 2],// Olympic Dam
  [139.6, -30.2, 1.5, 1.5], // Beverley
  [132.9, -12.7, 2, 1.5],// Ranger / Alligator Rivers
  [15, -22.5, 2, 1.5],   // Namibia (Rössing, Husab)
  [7.4, 18.7, 2, 1.5],   // Niger (Arlit)
  [64, 41.5, 2.5, 1.5],  // Uzbekistan
  [118, 50, 2, 1.5],     // Krasnokamensk
  [-107, 43, 2.5, 1.5],  // Wyoming
  [-109.5, 38, 2.5, 2],  // Colorado Plateau
  [27, -26.5, 2, 1.5],   // South Africa (Witwatersrand)
  [81, 44, 2, 1],        // Xinjiang (Yili)
  [33, 48, 1.5, 1],      // Ukraine
  [13, 50.5, 1.2, 0.7],  // Erzgebirge
  [-42.5, -14, 1.5, 1.5],// Brazil (Caetité)
  [113, 47, 2, 1.5],     // Mongolia (Dornod)
  [13.5, -1.5, 1, 1],    // Gabon
  [86, 23, 1.5, 1],      // India (Jharkhand)
  [35.5, -10, 1.5, 1.5], // Tanzania / Malawi
];

// Arid areas not covered by Natural Earth desert polygons: [lonMin, lonMax, latMin, latMax, probability]
export const EXTRA_DESERTS: [number, number, number, number, number][] = [
  [-17, 58, 17, 30.5, 0.85],    // Sahara + Arabia core
  [36, 50, 24, 33, 0.8],        // Syria / Iraq / Jordan / north Saudi
  [53, 62, 28, 35, 0.6],        // Iranian plateau
  [117, 145, -31, -19, 0.78],   // Australian outback
  [52, 75, 38, 46, 0.5],        // Central Asian steppe-desert
  [95, 115, 39, 45, 0.6],       // Gobi fringe
  [-120, -103, 31, 40, 0.45],   // US southwest
  [-71.5, -68.5, -28, -17, 0.8],// Atacama
  [40, 51, 2, 12, 0.5],         // Horn of Africa
  [-71, -64, -50, -38, 0.4],    // Patagonia
  [18, 25, -28, -20, 0.55],     // Kalahari fringe
];
