// Runs inside an Electron utility process: starts the game server and reports back to the app.

import { startServer } from '../server/server.ts';

const parent = process.parentPort;
const env = process.env;

startServer({
  port: Number(env.PW_PORT || 8080),
  host: env.PW_HOST || '0.0.0.0',
  clientDir: env.PW_CLIENT_DIR,
  mapDir: env.PW_MAP_DIR,
  dataDir: env.PW_DATA_DIR,
  portFallback: 20,
}).then((srv) => {
  console.log(`server listening on port ${srv.port}`);
  parent.postMessage({ t: 'ready', port: srv.port });
  parent.on('message', (e) => {
    if (e.data?.t === 'shutdown') void srv.shutdown().finally(() => process.exit(0));
  });
}, (e: Error) => {
  console.error('server failed to start', e);
  parent.postMessage({ t: 'fatal', error: e.message });
  setTimeout(() => process.exit(1), 300);
});
