// Loads static map files from disk (shared with the client via client/public/maps).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeMap, mapFileName, type GameMap } from '../shared/mapdata.ts';
import { MAP_SIZES, type MapSizeKey } from '../shared/balance.ts';

let mapDir = '';
const cache = new Map<number, GameMap>();

/** Folder holding world-<W>.bin.gz. Defaults to client/public/maps in the source tree. */
export function getMapDir(): string {
  return mapDir || path.resolve(import.meta.dirname, '../client/public/maps');
}
export function setMapDir(dir: string) { mapDir = dir; }

export function loadMap(size: MapSizeKey): GameMap {
  const w = MAP_SIZES[size];
  let m = cache.get(w);
  if (!m) {
    const file = path.join(getMapDir(), mapFileName(w));
    if (!fs.existsSync(file)) throw new Error(`Map file missing: ${file}. Run "npm run mapgen".`);
    m = decodeMap(new Uint8Array(zlib.gunzipSync(fs.readFileSync(file))));
    cache.set(w, m);
  }
  return m;
}
