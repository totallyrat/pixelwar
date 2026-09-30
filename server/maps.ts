// Loads static map files from disk (shared with the client via client/public/maps).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeMap, mapFileName, type GameMap } from '../shared/mapdata.ts';
import { MAP_SIZES, type MapSizeKey } from '../shared/balance.ts';

export const MAP_DIR = path.resolve(import.meta.dirname, '../client/public/maps');
const cache = new Map<number, GameMap>();

export function loadMap(size: MapSizeKey): GameMap {
  const w = MAP_SIZES[size];
  let m = cache.get(w);
  if (!m) {
    const file = path.join(MAP_DIR, mapFileName(w));
    if (!fs.existsSync(file)) throw new Error(`Map file missing: ${file}. Run "npm run mapgen".`);
    m = decodeMap(new Uint8Array(zlib.gunzipSync(fs.readFileSync(file))));
    cache.set(w, m);
  }
  return m;
}
