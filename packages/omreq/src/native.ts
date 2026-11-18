import { createRequire } from 'node:module';
import { isMainThread } from 'node:worker_threads';
import bridgeVersion from './bridge-version.json';
import { OmreqError } from './errors.js';
import packageVersion from './version.json';
/** Generated from package.json by `pnpm generate`. */
export const VERSION: string = packageVersion.version;
export type ProfileCheck = {
  compatible: boolean;
  verification: 'custom-unverified' | 'bundled-verified';
  profileDigest: string;
  engineBuildId: string;
  requiredCapabilities: readonly string[];
  issues: readonly { code: string; path: string; message: string }[];
  normalizedConfig: unknown;
};
export interface NativeOperation {
  readonly id: number;
  read(): Promise<Buffer | null>;
  readAll(maxBytes: number): Promise<Buffer>;
  cleaned(): boolean;
  waitTerminal(): Promise<string | null>;
  waitCleanup(): Promise<void>;
  waitUploadStopped(): Promise<void>;
  waitUploadEpochEnded(epoch: number): Promise<void>;
  uploadDemand(): Promise<number>;
  uploadFail(epoch: number, code: string): boolean;
  uploadWrite(epoch: number, chunk: Buffer | null, sourceError: boolean): Promise<boolean>;
  uploadError(): string | null;
  cancel(code: string): void;
}
/**
 * `[status, httpVersion, url, headers, redirects, body, cleaned, operation]`.
 * `url` is set only when it differs from the requested URL; `headers` is
 * `name\0value\0…`; `redirects` is JSON history when there was any; `body` is
 * set when the whole response body arrived with the headers, otherwise
 * `operation` streams it.
 */
export type NativeStarted = [
  status: number,
  httpVersion: '1.0' | '1.1' | '2',
  url: string | undefined,
  headers: string,
  redirects: string | undefined,
  body: Buffer | undefined,
  cleaned: boolean,
  operation: NativeOperation | undefined,
];
export interface NativeClient {
  request(id: number, url: string, config: string, body?: Buffer): Promise<NativeStarted>;
  operation(id: number): NativeOperation | null;
  cancel(id: number, code: string): void;
  waitCleanup(id: number): Promise<void>;
  close(): Promise<void>;
  stats(): string;
  bufferBudget(): NativeBufferBudget;
  setCookie(value: string, url: string): void;
  getCookies(url: string): string;
  clearCookies(): void;
}
export interface NativeBufferBudget {
  reserve(bytes: number): void;
  release(): void;
}
interface NativeBuild {
  version: string;
  bridgeAbi: number;
  nodeApi: number;
  engineBuildId: string;
  capabilities: readonly string[];
  transport: string;
  tls: string;
  boringSslRevision: string;
  bundledTrustStores: readonly string[];
  stage: string;
}
interface NativeModule {
  buildInfo(): string;
  checkProfile(profile: string): string;
  profileReport(profile: string): string;
  NativeClient: new (profile: string, config: string) => NativeClient;
}
/** Native package per `${platform}-${arch}`; see scripts/native-target.mjs. */
export const NATIVE_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  'darwin-arm64': '@omreq/darwin-arm64',
  'linux-x64': '@omreq/linux-x64-gnu',
  'win32-x64': '@omreq/win32-x64-msvc',
});
const MIN_NODE_MAJOR = 22;
function isMusl(): boolean {
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    // Runtimes without a diagnostic report (Bun) are assumed to be glibc.
    return report?.header !== undefined && !report.header.glibcVersionRuntime;
  } catch {
    return false;
  }
}
let loaded: NativeModule | undefined;
let build: NativeBuild | undefined;
const localRequire = createRequire(__filename);
export function loadNative(): NativeModule {
  if (loaded) return loaded;
  if (!isMainThread)
    throw new OmreqError(
      'ERR_UNSUPPORTED_RUNTIME',
      'native-load',
      'Workers are outside the qualified runtime scope',
    );
  const target = `${process.platform}-${process.arch}`;
  const nativePackage = NATIVE_PACKAGES[target];
  if (nativePackage === undefined)
    throw new OmreqError(
      'ERR_UNSUPPORTED_PLATFORM',
      'native-load',
      `No native build for ${target}; supported: ${Object.keys(NATIVE_PACKAGES).join(', ')}`,
    );
  if (process.platform === 'linux' && isMusl())
    throw new OmreqError(
      'ERR_UNSUPPORTED_PLATFORM',
      'native-load',
      'Linux builds require glibc; musl (Alpine) is not supported yet',
    );
  if (!process.versions.bun && Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR)
    throw new OmreqError(
      'ERR_UNSUPPORTED_RUNTIME',
      'native-load',
      `Use Node ${MIN_NODE_MAJOR} or newer, or Bun`,
    );
  if (Number(process.versions.napi) < 8)
    throw new OmreqError('ERR_UNSUPPORTED_RUNTIME', 'native-load', 'Node-API 8 is required');
  let entry: string;
  try {
    entry = localRequire.resolve(nativePackage);
  } catch (cause) {
    throw new OmreqError(
      'ERR_NATIVE_NOT_FOUND',
      'native-load',
      `Install the matching optional package ${nativePackage}@${VERSION}`,
      { cause },
    );
  }
  let module: NativeModule;
  try {
    module = localRequire(entry) as NativeModule;
  } catch (cause) {
    throw new OmreqError(
      'ERR_NATIVE_LOAD',
      'native-load',
      'The native binary could not be loaded by the dynamic linker',
      { cause },
    );
  }
  let info: NativeBuild;
  try {
    info = JSON.parse(module.buildInfo()) as NativeBuild;
  } catch (cause) {
    throw new OmreqError(
      'ERR_NATIVE_VERSION_MISMATCH',
      'native-load',
      'Native module has no compatible build manifest',
      { cause },
    );
  }
  if (
    !info ||
    typeof info !== 'object' ||
    info.version !== VERSION ||
    info.bridgeAbi !== bridgeVersion.abi ||
    info.nodeApi !== 8 ||
    !Array.isArray(info.capabilities) ||
    !Array.isArray(info.bundledTrustStores) ||
    info.capabilities.some((v) => typeof v !== 'string') ||
    info.bundledTrustStores.some((v) => typeof v !== 'string') ||
    !['engineBuildId', 'transport', 'tls', 'boringSslRevision', 'stage'].every(
      (key) =>
        typeof info[key as keyof NativeBuild] === 'string' && !!info[key as keyof NativeBuild],
    )
  )
    throw new OmreqError(
      'ERR_NATIVE_VERSION_MISMATCH',
      'native-load',
      'JavaScript/native version or bridge ABI mismatch',
    );
  loaded = module;
  build = Object.freeze({
    ...info,
    capabilities: Object.freeze([...info.capabilities]),
    bundledTrustStores: Object.freeze([...info.bundledTrustStores]),
  });
  return module;
}
export function getRuntimeInfo() {
  return Object.freeze({
    runtime: process.versions.bun ? 'bun' : 'node',
    runtimeVersion: process.versions.bun ?? process.versions.node,
    platform: process.platform,
    arch: process.arch,
    packageVersion: VERSION,
    nodeApi: process.versions.napi ?? null,
    nativeReady: !!loaded,
    native: build ?? null,
  });
}
