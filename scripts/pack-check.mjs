import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fixture } from '../fixtures/server.mjs';

const packagesDir = resolve('artifacts/packages');
mkdirSync(packagesDir, { recursive: true });
// Install logs and the matrix go here; artifacts/ is untracked, so a clean CI
// checkout does not have it.
mkdirSync('artifacts/qualification', { recursive: true });
const report = [];
const packages = [];
for (const dir of ['native/omreq-darwin-arm64', 'packages/omreq']) {
  execFileSync('pnpm', ['--dir', dir, 'pack', '--pack-destination', packagesDir], {
    stdio: 'pipe',
  });
  const original = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const file = join(packagesDir, `${original.name}-${original.version}.tgz`);
  const data = readFileSync(file),
    manifest = JSON.parse(
      execFileSync('tar', ['-xOf', file, 'package/package.json'], { encoding: 'utf8' }),
    );
  const files = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n');
  if (files.some((f) => /\.(pem|key)$|\/tests\/|\/fixtures\/|\.env|Cargo\.toml/.test(f)))
    throw Error('Unexpected tarball content');
  if (manifest.scripts?.install || manifest.scripts?.postinstall)
    throw Error('Install-time scripts are prohibited');
  if (
    manifest.name === 'omreq' &&
    manifest.optionalDependencies['omreq-darwin-arm64'] !== manifest.version
  )
    throw Error('Root/native dependency must be exact');
  packages.push({
    manifest,
    data,
    file,
    integrity: `sha512-${createHash('sha512').update(data).digest('base64')}`,
    files,
    sha256: createHash('sha256').update(data).digest('hex'),
  });
}
const lookup = new Map(packages.map((p) => [p.manifest.name, p]));
let registryRequests = 0;
const registry = http.createServer((req, res) => {
  registryRequests++;
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1));
  const p = lookup.get(path);
  if (p) {
    res.setHeader('content-type', 'application/json');
    const v = p.manifest.version;
    res.end(
      JSON.stringify({
        name: p.manifest.name,
        'dist-tags': { latest: v },
        versions: {
          [v]: {
            ...p.manifest,
            dist: { tarball: `${registryUrl}/${p.manifest.name}.tgz`, integrity: p.integrity },
          },
        },
      }),
    );
    return;
  }
  const tar = packages.find((p) => path === `${p.manifest.name}.tgz`);
  if (tar) {
    res.setHeader('content-type', 'application/octet-stream');
    res.end(tar.data);
    return;
  }
  if (path.includes('/-/npm/')) {
    res.setHeader('content-type', 'application/json');
    res.end('{}');
    return;
  }
  res.writeHead(307, { location: `https://registry.npmjs.org/${path}` });
  res.end();
});
registry.listen(0, '127.0.0.1');
await once(registry, 'listening');
const registryUrl = `http://127.0.0.1:${registry.address().port}`;
async function command(binary, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const p = spawn(binary, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    p.stdout.on('data', (b) => (log += b));
    p.stderr.on('data', (b) => (log += b));
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(Error('Install subprocess deadline exceeded'));
    }, 120000);
    p.on('error', reject);
    p.on('exit', (status) => {
      clearTimeout(timer);
      if (status !== 0) reject(Error(`${binary} ${args.join(' ')} exited ${status}\n${log}`));
      else resolve(log);
    });
  });
}
const fixtureServer = await fixture();
try {
  for (const manager of ['npm', 'pnpm', 'bun']) {
    const dir = mkdtempSync(join(tmpdir(), `omreq-pack-${manager}-`));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'omreq-clean-consumer', version: '1.0.0', private: true }),
      );
      const guard = join(dir, 'bin');
      mkdirSync(guard);
      const marker = join(dir, 'compiler-used');
      for (const name of ['rustc', 'cargo', 'cmake', 'clang', 'cc', 'c++'])
        writeFileSync(
          join(guard, name),
          '#!/bin/sh\necho forbidden > "$OMREQ_FORBIDDEN_TOOL_MARKER"\nexit 97\n',
          { mode: 0o755 },
        );
      for (const name of ['node', 'npm', 'pnpm', 'bun']) {
        const path = execFileSync('which', [name], { encoding: 'utf8' }).trim();
        symlinkSync(path, join(guard, name));
      }
      const env = {
        ...process.env,
        PATH: `${guard}:/usr/bin:/bin`,
        OMREQ_FORBIDDEN_TOOL_MARKER: marker,
        npm_config_cache: join(dir, 'npm-cache'),
        BUN_INSTALL_CACHE_DIR: join(dir, 'bun-cache'),
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_update_notifier: 'false',
      };
      const opts = { cwd: dir, env };
      const version = await command(join(guard, manager), ['--version'], opts);
      const install = manager === 'npm' ? ['install'] : manager === 'pnpm' ? ['add'] : ['add'];
      const flags = manager === 'pnpm' ? ['--store-dir', join(dir, 'pnpm-store')] : [];
      let log = await command(
        join(guard, manager),
        [...install, 'omreq@0.0.0-internal.1', '--registry', registryUrl, ...flags],
        opts,
      );
      const smoke = `const a=require('omreq');(async()=>{const b=await import('omreq');if(a.createClient!==b.createClient)throw Error('different loaders');const c=a.createClient();const r=await c.get(${JSON.stringify(`${fixtureServer.url}/echo`)});const v=await r.json();if(v.method!=='GET')throw Error('request failed');await c.close();console.log(JSON.stringify(a.getRuntimeInfo()));})().catch(e=>{console.error(e);process.exitCode=1;});`;
      log += await command(join(guard, 'node'), ['-e', smoke], opts);
      log += await command(join(guard, 'bun'), ['-e', smoke], opts);
      rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
      const before = registryRequests;
      log += await command(
        join(guard, manager),
        [
          'install',
          '--offline',
          '--ignore-scripts',
          ...(manager === 'pnpm' ? ['--store-dir', join(dir, 'pnpm-store')] : []),
          '--registry',
          registryUrl,
        ],
        opts,
      );
      if (registryRequests !== before) throw Error('Offline install contacted the registry');
      log += await command(join(guard, 'node'), ['-e', smoke], opts);
      if (existsSync(marker)) throw Error('Consumer installation invoked a compiler');
      writeFileSync(`artifacts/qualification/install-${manager}.log`, log);
      report.push({
        manager,
        version: version.trim(),
        ordinaryInstall: 'pass',
        offlineIgnoreScriptsInstall: 'pass',
        esmCjsNode: 'pass',
        bun: 'pass',
        compilerInvocations: 0,
      });
      console.log(`${manager}: normal + offline --ignore-scripts + Node/Bun ESM/CJS passed`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  writeFileSync(
    'artifacts/qualification/install-matrix.json',
    `${JSON.stringify(
      {
        packages: packages.map(({ manifest, file, files, sha256, integrity }) => ({
          name: manifest.name,
          version: manifest.version,
          file,
          files,
          sha256,
          integrity,
        })),
        consumers: report,
        limitations: [
          'Compiler guard simulates unavailable build tools on the current OS; this is not a clean minimum-OS machine.',
          'Different-architecture lockfile recovery and missing optional native package installation remain additional alpha scenarios.',
        ],
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await fixtureServer.close();
  await new Promise((r) => registry.close(r));
}
