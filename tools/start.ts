// npm start: build the client if needed, then run the game server (http://localhost:8080).
import { ensureBuilt } from './common.ts';

ensureBuilt();
await import('../server/main.ts');
