// Hand-drawn 7x7 pixel glyphs, rendered at runtime (no image assets needed).

const G: Record<string, string[]> = {
  city: ['...#...', '..###..', '#.###.#', '#######', '#.#.#.#', '#######', '#.#.#.#'],
  farm: ['#..#..#', '.#.#.#.', '#..#..#', '.#.#.#.', '..###..', '...#...', '#######'],
  factory: ['#......', '#..#...', '#..#..#', '#######', '#.#.#.#', '#######', '#######'],
  oil: ['...#...', '..#.#..', '..###..', '.#.#.#.', '.#####.', '#.....#', '#######'],
  uranium: ['.#...#.', '###.###', '.##.##.', '...#...', '.......', '..###..', '..###..'],
  barracks: ['...#...', '...#...', '#######', '.#####.', '..###..', '.##.##.', '##...##'],
  tankfac: ['.......', '..##...', '.#####.', '.######', '#######', '#.#.#.#', '.......'],
  shipyard: ['..###..', '...#...', '.#####.', '...#...', '#..#..#', '.#.#.#.', '..###..'],
  airbase: ['...#...', '...#...', '.#####.', '#######', '...#...', '..###..', '.......'],
  radar: ['#.....#', '.#...#.', '..###..', '...#...', '...#...', '..###..', '.#####.'],
  airdef: ['.#...#.', '###.###', '.#...#.', '.#...#.', '.##.##.', '#######', '#######'],
  bunker: ['#.#.#.#', '#######', '#######', '##...##', '##...##', '#######', '.......'],
  silo: ['...#...', '..###..', '..###..', '..###..', '..###..', '.#####.', '##.#.##'],
  nuclear: ['.#####.', '..###..', '..###..', '..###..', '.#####.', '#######', '#######'],
  money: ['...#...', '.#####.', '##.#...', '.#####.', '...#.##', '.#####.', '...#...'],
  prod: ['..#.#..', '.#####.', '###.###', '##...##', '###.###', '.#####.', '..#.#..'],
  food: ['#..#..#', '.#.#.#.', '#..#..#', '.#.#.#.', '..###..', '...#...', '...#...'],
  drop: ['...#...', '..###..', '.#####.', '.#####.', '#######', '#######', '.#####.'],
  pop: ['..###..', '..###..', '...#...', '.#####.', '...#...', '..#.#..', '.#...#.'],
  troops: ['#.....#', '.#...#.', '..#.#..', '...#...', '..#.#..', '##...##', '##...##'],
  tank: ['.......', '..##...', '.#####.', '.######', '#######', '#.#.#.#', '.......'],
  happy: ['.#####.', '#######', '##.#.##', '#######', '#.###.#', '##...##', '.#####.'],
  score: ['#######', '#.###.#', '.#####.', '..###..', '...#...', '..###..', '.#####.'],
  warship: ['.......', '...#...', '..###..', '.#####.', '#######', '.#####.', '.......'],
  transport: ['.......', '.......', '.#.#.#.', '#######', '#######', '.#####.', '.......'],
  fighter: ['...#...', '..###..', '.#####.', '#######', '...#...', '..###..', '.......'],
  bomber: ['...#...', '...#...', '#######', '#######', '...#...', '..###..', '.......'],
  missile: ['...#...', '..###..', '..###..', '..###..', '..###..', '.#####.', '##.#.##'],
  nuke: ['.#...#.', '###.###', '.##.##.', '...#...', '.......', '..###..', '..###..'],
  ping: ['..###..', '..###..', '..###..', '..###..', '.......', '..###..', '..###..'],
  chat: ['#######', '#.....#', '#.#.#.#', '#.....#', '#######', '.##....', '.#.....'],
  diplo: ['#......', '#####..', '#######', '#####..', '#......', '#......', '#......'],
  build: ['.####..', '.######', '.####..', '..##...', '..##...', '..##...', '..##...'],
  menu: ['.......', '#######', '.......', '#######', '.......', '#######', '.......'],
  sound: ['...#...', '..##...', '####.#.', '####..#', '####.#.', '..##...', '...#...'],
  star: ['...#...', '...#...', '#######', '.#####.', '..###..', '.##.##.', '##...##'],
  crown: ['#..#..#', '#.###.#', '#######', '#######', '#######', '.......', '.......'],
  target: ['..###..', '.#...#.', '#..#..#', '#.###.#', '#..#..#', '.#...#.', '..###..'],
  close: ['#.....#', '.#...#.', '..#.#..', '...#...', '..#.#..', '.#...#.', '#.....#'],
  shield: ['#######', '#######', '#######', '.#####.', '.#####.', '..###..', '...#...'],
};

export const BUILDING_GLYPH = ['', 'city', 'farm', 'factory', 'oil', 'uranium', 'barracks', 'tankfac', 'shipyard', 'airbase', 'radar', 'airdef', 'bunker', 'silo', 'nuclear'];
export const UNIT_GLYPH = ['tank', 'warship', 'transport', 'fighter', 'bomber', 'missile', 'nuke'];

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0');
export const cssColor = hex;
export function luminance(c: number): number {
  return (0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255)) / 255;
}

export function glyphCanvas(name: string, color: string, px = 1, pad = 0): HTMLCanvasElement {
  const g = G[name] ?? G.ping;
  const c = document.createElement('canvas');
  c.width = (7 + pad * 2) * px;
  c.height = (7 + pad * 2) * px;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) if (g[y][x] === '#') ctx.fillRect((x + pad) * px, (y + pad) * px, px, px);
  return c;
}

const urlCache = new Map<string, string>();
/** Data URL of a glyph, for use in <img> tags. */
export function icon(name: string, color = '#fff', px = 3): string {
  const k = `${name}|${color}|${px}`;
  let u = urlCache.get(k);
  if (!u) { u = glyphCanvas(name, color, px).toDataURL(); urlCache.set(k, u); }
  return u;
}
export function iconImg(name: string, color = '#fff', cls = 'ico'): string {
  return `<img class="${cls}" src="${icon(name, color)}" alt="">`;
}

const badgeCache = new Map<string, HTMLCanvasElement>();
/** 11x11 building badge: dark outline, owner colour fill, contrasting glyph. */
export function badge(type: number, owner: number): HTMLCanvasElement {
  const k = `${type}|${owner}`;
  let c = badgeCache.get(k);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 11;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#0a0d14';
  ctx.fillRect(0, 0, 11, 11);
  ctx.fillStyle = hex(owner);
  ctx.fillRect(1, 1, 9, 9);
  const light = luminance(owner) > 0.6;
  ctx.drawImage(glyphCanvas(BUILDING_GLYPH[type], light ? '#0a0d14' : '#ffffff', 1), 2, 2);
  badgeCache.set(k, c);
  return c;
}

const shipCache = new Map<string, HTMLCanvasElement>();
export function shipSprite(type: number, owner: number): HTMLCanvasElement {
  const k = `${type}|${owner}`;
  let c = shipCache.get(k);
  if (c) return c;
  const rows = type === 1
    ? ['...##....', '..####...', '.#######.', '#########', '.#######.']
    : ['.........', '..##.....', '.#######.', '#########', '.#######.'];
  c = document.createElement('canvas');
  c.width = 11; c.height = 7;
  const ctx = c.getContext('2d')!;
  // outline pass
  ctx.fillStyle = '#05070c';
  for (let y = 0; y < rows.length; y++) for (let x = 0; x < 9; x++) if (rows[y][x] === '#') ctx.fillRect(x, y, 3, 3);
  ctx.fillStyle = hex(owner);
  for (let y = 0; y < rows.length; y++) for (let x = 0; x < 9; x++) if (rows[y][x] === '#') ctx.fillRect(x + 1, y + 1, 1, 1);
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  ctx.fillRect(3, 4, 5, 1);
  shipCache.set(k, c);
  return c;
}

const starCanvas = new Map<string, HTMLCanvasElement>();
export function star(color: string): HTMLCanvasElement {
  let c = starCanvas.get(color);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = 9;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(glyphCanvas('star', '#05070c', 1), 0, 1);
    ctx.drawImage(glyphCanvas('star', '#05070c', 1), 2, 1);
    ctx.drawImage(glyphCanvas('star', '#05070c', 1), 1, 0);
    ctx.drawImage(glyphCanvas('star', '#05070c', 1), 1, 2);
    ctx.drawImage(glyphCanvas('star', color, 1), 1, 1);
    starCanvas.set(color, c);
  }
  return c;
}
