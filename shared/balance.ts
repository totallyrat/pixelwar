// ============================================================================================
//  PIXEL WAR - BALANCE CONFIG
//  Every gameplay number lives in this file. Distances/ranges are in tiles on the reference
//  1024-wide map and are scaled automatically for other map sizes (see mapScale()).
//  Per-tile quantities (population, food, conquest cost) are scaled by area so that a nation
//  covering the same part of the globe behaves the same on every map size.
// ============================================================================================

export const TICK_RATE = 5;                 // server simulation ticks per second
export const TICK_MS = 1000 / TICK_RATE;
export const REF_W = 1024;                  // reference map width all numbers are tuned for

export const MAP_SIZES = { small: 512, medium: 1024, large: 2048 } as const;
export type MapSizeKey = keyof typeof MAP_SIZES;

export const LIMITS = {
  maxHumans: 20,
  maxAI: 500,
  maxPlayers: 1024,          // id capacity (humans + AI + rebel nations), id 0 = nobody
  maxRooms: 6,
  maxQueue: 25,              // units queued per unit type
  chatLength: 200,
  intentsPerSecond: 25,
};

// ---- terrain ----------------------------------------------------------------------------
export const T = { OCEAN: 0, SHALLOW: 1, PLAINS: 2, FOREST: 3, MOUNTAIN: 4, DESERT: 5, ICE: 6, COAST: 7 } as const;

export interface TerrainDef {
  name: string;
  water: boolean;
  pop: number;      // population capacity per tile
  food: number;     // passive food/s per tile
  cost: number;     // troops needed to take a neutral tile
  def: number;      // defence multiplier when attacked
  tank: number;     // tank effectiveness multiplier
  farm: number;     // farm output multiplier
  step: number;     // conquest wave travel cost (higher = slower)
  trade: number;    // passive money/s per tile
  color: number;    // 0xRRGGBB
}
const W_: TerrainDef = { name: '', water: true, pop: 0, food: 0, cost: 0, def: 1, tank: 1, farm: 0, step: 1, trade: 0, color: 0 };
export const TERRAIN: TerrainDef[] = [
  { ...W_, name: 'Ocean', color: 0x173a61 },
  { ...W_, name: 'Shallows', color: 0x21507f },
  { name: 'Plains', water: false, pop: 120, food: 0.02, cost: 8, def: 1.0, tank: 1.25, farm: 1.3, step: 1.0, trade: 0, color: 0x6b9a48 },
  { name: 'Forest', water: false, pop: 90, food: 0.012, cost: 11, def: 1.35, tank: 0.6, farm: 0.8, step: 1.45, trade: 0, color: 0x3d6d3b },
  { name: 'Mountain', water: false, pop: 45, food: 0.004, cost: 18, def: 2.0, tank: 0.35, farm: 0.4, step: 2.3, trade: 0, color: 0x8a7d6c },
  { name: 'Desert', water: false, pop: 25, food: 0.002, cost: 10, def: 1.1, tank: 1.15, farm: 0.3, step: 1.2, trade: 0, color: 0xd6bd7c },
  { name: 'Ice', water: false, pop: 8, food: 0, cost: 14, def: 1.4, tank: 0.5, farm: 0.1, step: 1.8, trade: 0, color: 0xe4ecf0 },
  { name: 'Coast', water: false, pop: 140, food: 0.02, cost: 8, def: 0.9, tank: 1.1, farm: 1.1, step: 1.0, trade: 0.03, color: 0xc4b27a },
];

// ---- resources --------------------------------------------------------------------------
export const RES = { NONE: 0, OIL: 1, URANIUM: 2 } as const;

export interface Cost { money?: number; prod?: number; oil?: number; uranium?: number }

// ---- buildings --------------------------------------------------------------------------
export const B = {
  NONE: 0, CITY: 1, FARM: 2, FACTORY: 3, OIL_WELL: 4, URANIUM_MINE: 5, BARRACKS: 6, TANK_FACTORY: 7,
  SHIPYARD: 8, AIRBASE: 9, RADAR: 10, AIR_DEFENSE: 11, BUNKER: 12, MISSILE_SILO: 13, NUCLEAR_FACILITY: 14,
} as const;
export const BUILDING_COUNT = 15;

export interface BuildingDef {
  key: string;
  name: string;
  desc: string;
  cost: Cost;
  time: number;           // build seconds
  maxLevel: number;
  req?: 'oil' | 'uranium' | 'coast';
  slot: boolean;          // consumes a building slot (cities provide slots)
  scale: number;          // each one you already own adds this fraction of the base cost to the next
}
export const BUILDINGS: BuildingDef[] = [
  { key: 'none', name: '', desc: '', cost: {}, time: 0, maxLevel: 0, slot: false, scale: 0 },
  { key: 'city', name: 'City', desc: '+Pop cap, +money, +6 building slots per level', cost: { money: 700, prod: 150 }, time: 18, maxLevel: 5, slot: false, scale: 0.3 },
  { key: 'farm', name: 'Farm', desc: '+Food (best on plains)', cost: { money: 150 }, time: 7, maxLevel: 3, slot: true, scale: 0.12 },
  { key: 'factory', name: 'Factory', desc: '+Production', cost: { money: 350, prod: 30 }, time: 10, maxLevel: 3, slot: true, scale: 0.18 },
  { key: 'oil', name: 'Oil Well', desc: '+Oil. Must sit on an oil deposit', cost: { money: 300, prod: 80 }, time: 10, maxLevel: 3, req: 'oil', slot: true, scale: 0.15 },
  { key: 'uranium', name: 'Uranium Mine', desc: '+Uranium. Must sit on a uranium deposit', cost: { money: 500, prod: 200 }, time: 14, maxLevel: 3, req: 'uranium', slot: true, scale: 0.2 },
  { key: 'barracks', name: 'Barracks', desc: 'Faster troop recruitment', cost: { money: 250, prod: 50 }, time: 8, maxLevel: 3, slot: true, scale: 0.22 },
  { key: 'tankfac', name: 'Tank Factory', desc: 'Builds tanks', cost: { money: 700, prod: 300 }, time: 16, maxLevel: 3, slot: true, scale: 0.35 },
  { key: 'shipyard', name: 'Shipyard', desc: 'Builds warships & transports. Coast only', cost: { money: 600, prod: 250 }, time: 16, maxLevel: 3, req: 'coast', slot: true, scale: 0.3 },
  { key: 'airbase', name: 'Airbase', desc: 'Builds fighters & bombers', cost: { money: 900, prod: 450, oil: 40 }, time: 20, maxLevel: 3, slot: true, scale: 0.4 },
  { key: 'radar', name: 'Radar', desc: 'Reveals fog, boosts nearby air defense', cost: { money: 450, prod: 150 }, time: 12, maxLevel: 3, slot: true, scale: 0.3 },
  { key: 'airdef', name: 'Air Defense', desc: 'Shoots down missiles, nukes & bombers', cost: { money: 700, prod: 350 }, time: 15, maxLevel: 3, slot: true, scale: 0.25 },
  { key: 'bunker', name: 'Bunker', desc: 'Nearby tiles are much harder to capture', cost: { money: 350, prod: 250 }, time: 12, maxLevel: 3, slot: true, scale: 0.2 },
  { key: 'silo', name: 'Missile Silo', desc: 'Builds & launches missiles, launches nukes', cost: { money: 1800, prod: 900, oil: 60 }, time: 30, maxLevel: 3, slot: true, scale: 0.5 },
  { key: 'nuclear', name: 'Nuclear Facility', desc: 'Builds nuclear warheads. Lv 2 unlocks the Mega Nuke', cost: { money: 4000, prod: 2000, uranium: 60 }, time: 60, maxLevel: 2, slot: true, scale: 1.0 },
];
export const UPGRADE_COST_MULT = 1.8;       // cost of level L+1 = base * mult^L
export const UPGRADE_TIME = 0.5;            // upgrading takes half the time of building a new one
export const DEMOLISH_REFUND = 0.3;
export const BUILDING_SPACING = 2;          // min Chebyshev gap (ref tiles) between buildings

export const EFFECT = {
  cityPop: 5000,          // per level
  cityMoney: 4,           // money/s per level
  citySlots: 6,           // building slots per level
  farmFood: 7,            // food/s per level (x terrain.farm)
  factoryProd: 4,         // production/s per level
  oilWell: 1.5,           // oil/s per level
  uraniumMine: 0.35,      // uranium/s per level
  barracksRecruit: 0.006, // extra fraction of civilians recruited per second per level
};

// ---- units ------------------------------------------------------------------------------
export const U = { TANK: 0, WARSHIP: 1, TRANSPORT: 2, FIGHTER: 3, BOMBER: 4, MISSILE: 5, NUKE: 6, MEGA_NUKE: 7 } as const;
export const UNIT_COUNT = 8;
export interface UnitDef {
  key: string; name: string; desc: string; cost: Cost; time: number; building: number; upkeep: number;
  minLevel?: number;      // required level of one building of that type
  scale?: number;         // each one in stock/queue adds this fraction of the base cost to the next
}
export const UNITS: UnitDef[] = [
  { key: 'tank', name: 'Tank', desc: 'Armoured battalion: worth 120 infantry on plains, weak in forest/mountains. Costs no population.', cost: { money: 300, prod: 150, oil: 12 }, time: 5, building: B.TANK_FACTORY, upkeep: 0.2 },
  { key: 'warship', name: 'Warship', desc: 'Sinks enemy ships, shells coasts', cost: { money: 500, prod: 300, oil: 40 }, time: 22, building: B.SHIPYARD, upkeep: 0.6 },
  { key: 'transport', name: 'Transport', desc: 'Carries troops for naval invasions', cost: { money: 150, prod: 60, oil: 8 }, time: 7, building: B.SHIPYARD, upkeep: 0.1 },
  { key: 'fighter', name: 'Fighter', desc: 'Intercepts enemy bombers near your airbases', cost: { money: 350, prod: 200, oil: 30 }, time: 14, building: B.AIRBASE, upkeep: 0.4 },
  { key: 'bomber', name: 'Bomber', desc: 'Strikes buildings & troops within airbase range', cost: { money: 600, prod: 300, oil: 50 }, time: 18, building: B.AIRBASE, upkeep: 0.5 },
  { key: 'missile', name: 'Missile', desc: 'Conventional strike, range-limited', cost: { money: 900, prod: 450, oil: 40 }, time: 18, building: B.MISSILE_SILO, upkeep: 0, scale: 0.1 },
  { key: 'nuke', name: 'Medium Nuke', desc: 'Flattens a whole region. Everyone will see the launch.', cost: { money: 5000, prod: 2500, uranium: 120 }, time: 90, building: B.NUCLEAR_FACILITY, upkeep: 0, scale: 0.4 },
  { key: 'mega', name: 'Mega Nuke', desc: 'Wipes out a big chunk of a country. Needs a Lv 2 Nuclear Facility.', cost: { money: 22000, prod: 12000, uranium: 480 }, time: 200, building: B.NUCLEAR_FACILITY, upkeep: 0, minLevel: 2, scale: 0.6 },
];

/** Warhead tiers, indexed by tier (0 = Medium Nuke, 1 = Mega Nuke). Distances in ref tiles. */
export const NUKE_TIERS = [
  { unit: U.NUKE, name: 'Medium Nuke', radius: 16, innerFrac: 0.55, flightSeconds: 15, falloutSeconds: 160, killMult: 3, autoIntercept: 0.22, manualIntercept: 0.5, winter: 1 },
  { unit: U.MEGA_NUKE, name: 'Mega Nuke', radius: 36, innerFrac: 0.62, flightSeconds: 20, falloutSeconds: 260, killMult: 6, autoIntercept: 0.1, manualIntercept: 0.3, winter: 3 },
];

export const TECH = {
  maxLevel: 5,
  step: 0.1,              // +10% attack (offense) or defence (defense) per level
  cost: (level: number): Cost => ({ money: Math.round(800 * 2 ** level), prod: Math.round(400 * 2 ** level) }),
};

// ---- economy ----------------------------------------------------------------------------
export const ECON = {
  startPop: 3000,
  startTroops: 1500,
  startMoney: 1200,
  startProd: 300,
  startFood: 300,
  capitalPop: 4000,
  capitalMoney: 6,
  capitalFood: 4,
  capitalProd: 2,
  capitalSlots: 8,
  growth: 0.03,           // logistic growth rate of population / s
  baseGrowth: 4,          // flat people / s
  tax: 0.004,             // money / s per civilian
  foodPerPop: 0.0008,
  foodPerTroop: 0.0012,
  recruitBase: 0.012,     // fraction of civilians recruited / s
  recruitMax: 0.05,
  demobilize: 0.02,
  defaultMobilization: 0.35,
  starveLoss: 0.012,      // population lost / s while starving
  starveDesert: 0.02,     // troops deserting / s while starving
  maxStock: 1e9,
};

export const HAPPY = {
  base: 70,
  foodSurplus: 8,
  starving: -40,
  mobilization: -35,      // x max(0, mobilization - 0.4) * 2.5
  fallout: -30,           // x fraction of territory under fallout (x5, capped)
  perCityLevel: 1.5,
  maxCityBonus: 15,
  warLosses: -25,         // recent territory loss fraction x ...
  traitor: -10,
  change: 1.5,            // points / s toward target
  rebelBelow: 15,
  rebelChance: 0.25,      // per 10s check
  rebelFraction: 0.1,
  outputMin: 0.45,        // output multiplier at 0 happiness
  outputMax: 1.15,        // at 100 happiness
};

// ---- combat -----------------------------------------------------------------------------
export const COMBAT = {
  defenderAdvantage: 1.6, // attacker pays density * terrain.def * fort * this per tile
  minTileCost: 3,
  defenderLoss: 0.9,      // defender loses density * this per tile lost
  waveSpeed: 0.9,         // wave cost units advanced per tick (ref map)
  speedMin: 0.4,
  speedMax: 1.5,
  maxTilesPerTick: 600,
  directionBias: 0.45,    // pull toward the tapped tile (wave cost per tile of distance)
  jitter: 0.6,
  tankPower: 120,
  tankDefense: 0.6,
  falloutCost: 1.6,
  capitalLossPop: 0.2,
  capitalLossHappy: -20,
  traitorDefense: 0.7,
  traitorSeconds: 120,
  minAttackTroops: 10,
  bunkerRange: 5,
  bunkerPerLevel: 0.5,    // +50% defence per bunker level in range
  bunkerMax: 3,
};

export const MISSILE = {
  range: 90,              // from nearest silo (ref tiles), + 20 per silo level above 1
  rangePerLevel: 20,
  speed: 25,              // tiles / s
  radius: 2.5,
  troopKill: 4,           // x (tiles hit / territory) x troops, plus flat per tile
  flatKill: 60,
  buildingImmune: [B.CITY] as number[], // capitals are only harmed by nukes; cities take damage (downgrade)
};

/** Rules shared by both warhead tiers (per-tier numbers live in NUKE_TIERS). */
export const NUKE = {
  manualRangeMult: 1.8,   // interceptor must come from a silo within missile range * this
  aiOpinionAll: -30,
  aiOpinionVictim: -90,
  winterThreshold: 3,
  winterStep: 0.1,
  winterMax: 0.6,
  winterDecaySeconds: 240,
};

export const AIR = {
  bomberRange: 75,
  bomberSpeed: 12,
  bombRadius: 1.5,
  bombKill: 250,
  fighterRange: 35,
  fighterIntercept: 0.12,
  interceptMax: 0.85,
};

export const AIRDEF = { range: 11, rangePerLevel: 3, missile: 0.4, bomber: 0.3, perLevel: 0.08, radarBonus: 0.15 };
export const RADAR = { range: 26, perLevel: 10 };

export const NAVAL = {
  warshipSpeed: 3,
  transportSpeed: 3.6,
  warshipHp: 100,
  transportHp: 30,
  warshipRange: 5,
  warshipDps: 14,
  bombardDps: 25,         // troops / s killed on enemy coast in range
  landingSearch: 6,
};

// ---- spawning / vision --------------------------------------------------------------------
export const SPAWN = { radius: 3, minDistance: 11, humanProtect: 16, seconds: 20 };
export const VISION = { block: 8, marginBlocks: 1, shipBlocks: 1 };

export const DIPLO = { napSeconds: 300, proposalSeconds: 30 };

/** Planned operations: timed, multi-step (and multi-nation) strikes. Times are real seconds. */
export const OPS = {
  maxActive: 6,           // planning / countdown / running operations per owner
  maxSteps: 16,
  maxDelay: 600,
  maxCountdown: 180,
  defaultGap: 5,          // seconds between steps in "sequence" mode
  keepSeconds: 90,        // finished operations stay visible this long
  aiInviteSeconds: 180,   // an AI invites a human ally to at most one operation per this period
  aiCountdown: 45,        // AI-led operations give invited allies this long to join
};

// ---- AI -----------------------------------------------------------------------------------
export const AI_LEVELS = ['passive', 'defensive', 'aggressive'] as const;
export const AI = {
  thinkSeconds: [2.6, 2.0, 1.5],
  mobilization: [0.25, 0.35, 0.45],
  expandFrac: [0.3, 0.4, 0.5],
  attackRatio: [2.2, 1.4, 1.0],   // needed strength ratio to attack a player
  attackFrac: [0.3, 0.4, 0.55],
  warChance: [0.04, 0.15, 0.4],   // chance per think to start a war with a weaker neighbour
  navalChance: [0.05, 0.15, 0.35],
  maxAllies: 3,
  techChance: [0.2, 0.35, 0.45],
  nukeChance: [0.02, 0.06, 0.25],
};

// ---- win / score --------------------------------------------------------------------------
export const WIN = { landPercent: 70 };
export const SCORE = { perTile: 10, perPop: 0.01, perTroop: 0.005, perBuildingLevel: 25, perTech: 60 };

// ---- helpers -------------------------------------------------------------------------------
export const mapScale = (w: number) => w / REF_W;            // linear distances
export const areaScale = (w: number) => (REF_W / w) ** 2;    // per-tile quantities

export function scaleCost(c: Cost, m: number): Cost {
  const r: Cost = {};
  if (c.money) r.money = Math.round(c.money * m);
  if (c.prod) r.prod = Math.round(c.prod * m);
  if (c.oil) r.oil = Math.round(c.oil * m);
  if (c.uranium) r.uranium = Math.round(c.uranium * m);
  return r;
}
/**
 * Cost of a building. level 0 = a new one, where `owned` (how many of that type you already have,
 * including ones under construction) makes each extra copy pricier. level >= 1 = upgrading an existing
 * building from that level, which does not depend on how many you own.
 */
export function buildCost(type: number, level: number, owned = 0): Cost {
  if (level === 0) return scaleCost(BUILDINGS[type].cost, 1 + BUILDINGS[type].scale * owned);
  return scaleCost(BUILDINGS[type].cost, UPGRADE_COST_MULT ** level);
}
/** Seconds to build (level 0) or to upgrade from `level` (always half of a new build). */
export function buildTime(type: number, level: number): number {
  const d = BUILDINGS[type];
  return level === 0 ? d.time : d.time * UPGRADE_TIME;
}
/** Cost of the next unit given how many are already stockpiled + queued (only warheads scale). */
export function unitCost(u: number, have = 0): Cost {
  const d = UNITS[u];
  return d.scale ? scaleCost(d.cost, 1 + d.scale * have) : d.cost;
}

export const HUMAN_COLORS = [
  0xe63946, 0x3a86ff, 0xffbe0b, 0x2ec4b6, 0xff006e, 0x8338ec, 0xfb5607, 0x06d6a0, 0xf15bb5, 0x00bbf9,
  0x9ef01a, 0xffffff, 0xff9f1c, 0x7209b7, 0x4cc9f0, 0xd00000, 0xfee440, 0x00f5d4, 0xb5179e, 0x80ed99,
];
