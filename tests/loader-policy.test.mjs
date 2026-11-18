import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { nativePackage } from './native-package.mjs';

const bridge = JSON.parse(await readFile(new URL('../bridge.json', import.meta.url), 'utf8'));
const require = createRequire(new URL('../packages/omreq/dist/index.js', import.meta.url));

function isolated(stub) {
  const dir = mkdtempSync(join(tmpdir(), 'omreq-loader-policy-'));
  cpSync(new URL('../packages/omreq/dist/', import.meta.url), join(dir, 'dist'), {
    recursive: true,
  });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  for (const dependency of ['jsonc-parser'])
    symlinkSync(
      dirname(require.resolve(`${dependency}/package.json`)),
      join(dir, 'node_modules', dependency),
      'junction',
    );
  if (stub !== undefined) {
    const native = join(dir, 'node_modules', nativePackage);
    mkdirSync(native);
    writeFileSync(
      join(native, 'package.json'),
      JSON.stringify({ name: nativePackage, main: 'index.cjs' }),
    );
    writeFileSync(join(native, 'index.cjs'), stub);
  }
  return dir;
}

async function child(code, executable = process.execPath) {
  return await new Promise((resolve, reject) => {
    const proc = spawn(executable, ['--input-type=module', '-e', code], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    proc.stdout.on('data', (value) => (stdout += value));
    proc.stderr.on('data', (value) => (stderr += value));
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(Error(`Loader subprocess did not exit within 5 seconds\n${stdout}\n${stderr}`));
    }, 5000);
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function requestCode(dir, mode, patch = '') {
  const entry = join(dir, 'dist', mode === 'esm' ? 'index.mjs' : 'index.js');
  return `
    import Module, {createRequire} from 'node:module';
    let resolutions = 0;
    const originalCreateRequire = Module.createRequire;
    Module.createRequire = (...args) => {
      const require = originalCreateRequire(...args);
      const resolve = require.resolve;
      require.resolve = (...values) => {
        if (values[0] === ${JSON.stringify(nativePackage)}) resolutions++;
        return resolve(...values);
      };
      return require;
    };
    ${patch}
    const {createClient} = ${mode === 'esm' ? `await import(${JSON.stringify(pathToFileURL(entry).href)})` : `createRequire(${JSON.stringify(pathToFileURL(entry).href)})(${JSON.stringify(entry)})`};
    const client = createClient();
    console.log(JSON.stringify({before:client.getInfo().nativeReady}));
    try {
      await client.get('http://127.0.0.1:1');
      throw Error('Unexpected request success');
    } catch (error) {
      console.log(JSON.stringify({code:error.code,phase:error.phase,message:error.message,resolutions}));
    }
    await client.close();
    console.log(JSON.stringify({after:client.getInfo().nativeReady,state:client.getStats().activeOperations}));
  `;
}

function output(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('T21/T24: platform, architecture, Node branch and N-API guards precede native resolution in ESM/CJS', async () => {
  const dir = isolated();
  try {
    for (const mode of ['esm', 'cjs']) {
      for (const [name, patch, code] of [
        [
          'platform',
          `Object.defineProperty(process,'platform',{value:'freebsd'});`,
          'ERR_UNSUPPORTED_PLATFORM',
        ],
        [
          'architecture',
          `Object.defineProperty(process,'arch',{value:'ia32'});`,
          'ERR_UNSUPPORTED_PLATFORM',
        ],
        ...['18.20.4', '20.19.0', '21.7.3'].map((version) => [
          `Node ${version}`,
          `Object.defineProperty(process.versions,'bun',{value:undefined,configurable:true});Object.defineProperty(process.versions,'node',{value:${JSON.stringify(version)}});`,
          'ERR_UNSUPPORTED_RUNTIME',
        ]),
        [
          'Node-API 7',
          `Object.defineProperty(process.versions,'napi',{value:'7'});`,
          'ERR_UNSUPPORTED_RUNTIME',
        ],
      ]) {
        const [before, error, after] = output(await child(requestCode(dir, mode, patch)));
        assert.deepEqual(before, { before: false }, `${mode}: ${name}`);
        assert.equal(error.code, code, `${mode}: ${name}`);
        assert.equal(error.phase, 'native-load', `${mode}: ${name}`);
        assert.equal(error.resolutions, 0, `${mode}: ${name} must not resolve a native binary`);
        assert.deepEqual(after, { after: false, state: 0 }, `${mode}: ${name}`);
      }
      const [, error] = output(await child(requestCode(dir, mode)));
      assert.equal(error.code, 'ERR_NATIVE_NOT_FOUND');
      assert.equal(error.resolutions, 1, 'Control request proves the native-resolution spy works');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T19/T21: real Node workers reject native loading and exit without active tasks', async () => {
  const dir = isolated();
  try {
    for (const mode of ['esm', 'cjs']) {
      const workerCode = `
        import {parentPort} from 'node:worker_threads';
        ${requestCode(dir, mode)}
        parentPort.postMessage('done');
        parentPort.close();
      `;
      const result = await child(
        `
          import {Worker} from 'node:worker_threads';
          const worker=new Worker(new URL(${JSON.stringify(`data:text/javascript,${encodeURIComponent(workerCode)}`)}),{type:'module'});
          await new Promise((resolve,reject)=>{
            worker.on('error',reject);
            worker.on('exit',code=>code===0?resolve():reject(Error('Worker exit '+code)));
          });
        `,
        'node',
      );
      const [before, error, after] = output(result);
      assert.deepEqual(before, { before: false });
      assert.equal(error.code, 'ERR_UNSUPPORTED_RUNTIME');
      assert.equal(error.phase, 'native-load');
      assert.match(error.message, /Workers/);
      assert.equal(error.resolutions, 0);
      assert.deepEqual(after, { after: false, state: 0 });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T21/T24: malformed native manifests produce structured mismatch errors in ESM/CJS', async () => {
  const base = {
    version: '0.1.0',
    bridgeAbi: bridge.abi,
    nodeApi: 8,
    engineBuildId: `omreq-engine-sha256:${'0'.repeat(64)}`,
    capabilities: [],
    bundledTrustStores: [],
    transport: 'wreq/0.16.3',
    tls: 'btls/test',
    boringSslRevision: '0'.repeat(40),
    stage: 'internal-prototype',
  };
  const stubs = [
    ['missing buildInfo', 'exports.notBuildInfo=()=>"{}";'],
    ['invalid JSON', 'exports.buildInfo=()=>"{invalid";'],
    ['null', 'exports.buildInfo=()=>"null";'],
    ['array', 'exports.buildInfo=()=>"[]";'],
    ['number', 'exports.buildInfo=()=>"42";'],
    ['string', 'exports.buildInfo=()=>JSON.stringify("manifest");'],
    ['missing fields', 'exports.buildInfo=()=>"{}";'],
    ...[
      ['capabilities', null],
      ['capabilities', [null]],
      ['bundledTrustStores', {}],
      ['bundledTrustStores', [42]],
      ['engineBuildId', null],
      ['transport', 42],
      ['tls', false],
      ['boringSslRevision', []],
      ['stage', null],
    ].map(([name, value]) => [
      `invalid ${name}`,
      `exports.buildInfo=()=>${JSON.stringify(JSON.stringify({ ...base, [name]: value }))};`,
    ]),
  ];
  for (const [name, stub] of stubs) {
    const dir = isolated(stub);
    try {
      for (const mode of ['esm', 'cjs']) {
        const [before, error, after] = output(await child(requestCode(dir, mode)));
        assert.deepEqual(before, { before: false }, `${mode}: ${name}`);
        assert.equal(
          error.code,
          'ERR_NATIVE_VERSION_MISMATCH',
          `${mode}: ${name}: ${error.message}`,
        );
        assert.equal(error.phase, 'native-load', `${mode}: ${name}`);
        assert.equal(error.resolutions, 1);
        assert.deepEqual(after, { after: false, state: 0 }, `${mode}: ${name}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
