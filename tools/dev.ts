// npm run dev: game server with auto-restart + Vite dev server with hot reload (http://localhost:5173).
import { spawn } from 'node:child_process';
import { ROOT, isWin } from './common.ts';

const procs = [
  spawn(process.execPath, ['--watch', 'server/main.ts'], { cwd: ROOT, stdio: 'inherit' }),
  spawn(isWin ? 'npx.cmd' : 'npx', ['vite'], { cwd: ROOT, stdio: 'inherit', shell: isWin }),
];
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
