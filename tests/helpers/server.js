// Shared helper: start/stop a local `wrangler pages dev` server with a throwaway D1 database.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEV_VARS = join(ROOT, '.dev.vars');
const THROWAWAY = 'SESSION_SECRET=test-secret-0123456789abcdef-0123456789abcdef\nOWNER_EMAIL=owner@example.com\nOWNER_PASSWORD=OwnerPass123!\n';

/** Create .dev.vars with throwaway values only if it does not exist. Never overwrites. Returns parsed values. */
export function ensureDevVars() {
  if (!existsSync(DEV_VARS)) {
    try { writeFileSync(DEV_VARS, THROWAWAY, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const vars = {};
  for (const line of readFileSync(DEV_VARS, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) vars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  for (const k of ['SESSION_SECRET', 'OWNER_EMAIL', 'OWNER_PASSWORD']) {
    if (!vars[k]) throw new Error(`.dev.vars is missing ${k}`);
  }
  if (vars.SESSION_SECRET.length < 32) throw new Error('.dev.vars SESSION_SECRET must be at least 32 characters');
  return vars;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{port:number}} opts
 * @returns {Promise<{baseUrl:string, dir:string, owner:{email:string,password:string}, stop:()=>Promise<void>, d1:(sql:string)=>any[]}>}
 */
export async function startServer({ port }) {
  const vars = ensureDevVars();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fetch(`${baseUrl}/api/me`, { signal: AbortSignal.timeout(1500) });
    throw new Error(`Something is already listening on port ${port}`);
  } catch (e) { if (/already listening/.test(e.message)) throw e; }

  const dir = mkdtempSync(join(tmpdir(), 'fab-test-'));
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', CI: '1' };
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'family-address-book', '--local', '--persist-to', dir],
    { cwd: ROOT, env, stdio: 'pipe', timeout: 120000 });

  const child = spawn('npx', ['wrangler', 'pages', 'dev', 'public', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', dir],
    { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  let exited = false;
  child.on('exit', () => { exited = true; });

  const kill = async () => {
    if (!child.pid) return;
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      try { process.kill(-child.pid, sig); } catch { /* group already gone */ }
      for (let i = 0; i < 30 && !exited; i++) await sleep(100);
      if (exited) break;
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  };

  const deadline = Date.now() + 120000;
  for (;;) {
    if (exited) { rmSync(dir, { recursive: true, force: true }); throw new Error(`wrangler exited early:\n${log}`); }
    if (Date.now() > deadline) { await kill(); throw new Error(`wrangler not ready in time:\n${log}`); }
    try {
      const r = await fetch(`${baseUrl}/api/me`, { signal: AbortSignal.timeout(5000) });
      if (r.status === 401) break;
    } catch { /* not up yet */ }
    await sleep(500);
  }

  return {
    baseUrl, dir, owner: { email: vars.OWNER_EMAIL.toLowerCase(), password: vars.OWNER_PASSWORD }, vars,
    /** Run a read-only SQL statement against the same local D1 files. */
    d1(sql) {
      const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'family-address-book', '--local', '--persist-to', dir, '--json', '--command', sql],
        { cwd: ROOT, env, stdio: 'pipe', timeout: 60000 }).toString();
      const start = out.indexOf('[');
      return JSON.parse(out.slice(start))[0].results;
    },
    async stop() {
      await kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
