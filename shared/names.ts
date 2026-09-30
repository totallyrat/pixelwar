// Nation naming and colours for AI nations and rebels.

const TEMPLATES = [
  '{C}', 'Republic of {C}', 'Kingdom of {C}', '{C} Federation', 'Free {C}', 'New {C}', '{C} Union',
  'Grand Duchy of {C}', '{C} Empire', "People's {C}", '{C} Commonwealth', 'United {C}', 'Emirate of {C}',
  'Sultanate of {C}', '{C} Confederacy', 'Holy {C}', 'Northern {C}', 'Southern {C}', 'Eastern {C}',
  'Western {C}', 'Greater {C}', 'Upper {C}', 'Lower {C}', '{C} Dominion', 'Principality of {C}',
  '{C} Directorate', 'Khanate of {C}', 'Tsardom of {C}', '{C} Protectorate', '{C} Syndicate',
  'Iron {C}', 'Red {C}', 'Golden {C}', '{C} Collective', 'Imperial {C}', '{C} Hegemony',
];
const SYLL_A = ['Ar', 'Bel', 'Cor', 'Dra', 'El', 'Fen', 'Gal', 'Hal', 'Is', 'Jor', 'Kal', 'Lor', 'Mar', 'Nor', 'Os', 'Pra', 'Qua', 'Ros', 'Sar', 'Tor', 'Ul', 'Val', 'Wes', 'Xan', 'Yar', 'Zel'];
const SYLL_B = ['ania', 'ovia', 'istan', 'land', 'mark', 'heim', 'burg', 'aria', 'onia', 'eria', 'ia', 'ador', 'esh', 'oria', 'ica'];

const synth = (rnd: () => number) => SYLL_A[(rnd() * SYLL_A.length) | 0] + SYLL_B[(rnd() * SYLL_B.length) | 0];

/** Name an AI nation after the real country it spawned in, falling back to invented names. */
export function aiName(countryName: string | null, rnd: () => number, used: Set<string>): string {
  const bases = [countryName && countryName.length < 20 ? countryName : null, synth(rnd), synth(rnd), synth(rnd)];
  for (const base of bases) {
    if (!base) continue;
    for (let tries = 0; tries < 10; tries++) {
      const name = TEMPLATES[(rnd() * TEMPLATES.length) | 0].replace('{C}', base);
      if (!used.has(name)) { used.add(name); return name; }
    }
  }
  let n = 2, base = synth(rnd);
  while (used.has(`${base} ${n}`)) n++;
  used.add(`${base} ${n}`);
  return `${base} ${n}`;
}

function hsl(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/** Muted-but-distinct colours for AI nations (humans get the bold HUMAN_COLORS). */
export function aiColor(i: number, rnd: () => number): number {
  const h = (i * 137.508) % 360;
  const s = 0.35 + rnd() * 0.3;
  const l = 0.38 + rnd() * 0.22;
  return hsl(h, s, l);
}
