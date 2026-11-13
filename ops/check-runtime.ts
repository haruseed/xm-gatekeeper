// PM2 JSON is consumed locally; never print its environment (which can contain secrets).
import { Database } from 'bun:sqlite';
import { loadConfig } from '@guard/core';
const config = loadConfig(process.env);
const processes = JSON.parse(await Bun.stdin.text()) as { name: string; pid: number; pm2_env: { status: string; pm_uptime: number } }[];
const processInfo = processes.find(p => p.name === 'ingress-guard');
if (!processInfo || !Number.isSafeInteger(processInfo.pid) || processInfo.pid <= 0 || !Number.isFinite(processInfo.pm2_env.pm_uptime) || processInfo.pm2_env.status !== 'online' || Date.now() - processInfo.pm2_env.pm_uptime < 3000) process.exit(1);
const db = new Database(config.databasePath, { readonly: true });
try {
  const row = db.query("SELECT value FROM runtime_state WHERE key='runtime_ready'").get() as { value: string } | null;
  const ready = JSON.parse(row?.value ?? '{}');
  if (ready.pid !== processInfo.pid || !Number.isFinite(ready.startedAt) || ready.startedAt < processInfo.pm2_env.pm_uptime - 1000) process.exit(1);
} finally { db.close(); }
if (config.webhook && config.cap) {
  const path = new URL(config.cap.publicUrl).pathname.replace(/\/$/, '');
  const response = await fetch(`http://127.0.0.1:${config.webhook.port}${path}`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok || !(await response.text()).includes('<title>XM Gatekeeper</title>')) process.exit(1);
}
console.log('runtime process, startup marker and configured Cap page verified');
