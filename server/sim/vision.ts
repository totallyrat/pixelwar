// Partial fog of war. Ownership of land is always public; buildings, ships, flights and troop
// counts are only revealed inside a player's (and allies') vision. Vision is tracked on a coarse
// grid of VISION.block x VISION.block tiles and recomputed once per second for human players.

import { VISION, RADAR, B } from '../../shared/balance.ts';
import type { Game } from './game.ts';
import type { Player } from './types.ts';

export function computeVision(g: Game) {
  const s = g.s;
  const fog = s.settings.fog;
  for (const p of s.players) {
    if (!p || !p.human) continue;
    let v = g.vis.get(p.id);
    if (!v) { v = new Uint8Array(g.BW * g.BH); g.vis.set(p.id, v); }
    if (!fog || !p.alive || s.phase !== 'running') { v.fill(1); continue; }
    v.fill(0);
    mark(g, p, v);
    for (const a of p.allies) { const q = g.P(a); if (q && q.alive) mark(g, q, v); }
  }
}

function mark(g: Game, p: Player, v: Uint8Array) {
  const BW = g.BW, BH = g.BH, mb = VISION.marginBlocks;
  for (const bk of p.blocks.keys()) {
    const bx = bk % BW, by = (bk / BW) | 0;
    for (let dy = -mb; dy <= mb; dy++) {
      const y = by + dy;
      if (y < 0 || y >= BH) continue;
      const row = y * BW;
      for (let dx = -mb; dx <= mb; dx++) {
        let x = bx + dx;
        if (x < 0) x += BW; else if (x >= BW) x -= BW;
        v[row + x] = 1;
      }
    }
  }
  const m = g.map;
  for (const id of p.btype[B.RADAR]) {
    const b = g.s.buildings[id]!;
    if (b.level <= 0) continue;
    const r = ((RADAR.range + (b.level - 1) * RADAR.perLevel) * m.ms) / VISION.block;
    circle(g, v, g.block(b.tile), r);
  }
  for (const sh of g.s.ships) if (sh.owner === p.id && sh.hp > 0) circle(g, v, g.block(sh.tile), VISION.shipBlocks);
}

function circle(g: Game, v: Uint8Array, center: number, r: number) {
  const BW = g.BW, BH = g.BH, cx = center % BW, cy = (center / BW) | 0, ri = Math.ceil(r), r2 = r * r + 0.5;
  for (let dy = -ri; dy <= ri; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= BH) continue;
    for (let dx = -ri; dx <= ri; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      let x = cx + dx;
      if (x < 0) x += BW; else if (x >= BW) x -= BW;
      v[y * BW + x] = 1;
    }
  }
}

export function canSee(g: Game, pid: number, t: number): boolean {
  const v = g.vis.get(pid);
  return !v || v[g.block(t)] === 1;
}
