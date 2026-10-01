// Command-line entry for the PIXEL WAR server.
//   PORT (default 8080)   HOST (default 0.0.0.0)   PW_OPEN=1 opens the browser once it is up

import { startServer } from './server.ts';

const srv = await startServer({ port: Number(process.env.PORT ?? 8080), host: process.env.HOST ?? '0.0.0.0' });

console.log(`\n  PIXEL WAR server running`);
console.log(`  local:   http://localhost:${srv.port}`);
for (const u of srv.lanUrls()) console.log(`  network: ${u}`);
console.log('');

if (process.env.PW_OPEN) {
  const url = `http://localhost:${srv.port}`;
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  import('node:child_process').then(({ spawn }) => spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).unref()).catch(() => {});
}

async function shutdown() {
  console.log('\nsaving rooms...');
  await srv.shutdown();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
