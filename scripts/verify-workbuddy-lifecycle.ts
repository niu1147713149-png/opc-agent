// Offline regression coverage: no real CLI, model requests, or user credentials.
import './lib/temp-data-dir.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { planSdkRuntime } from '../server/agents/sdkRuntime.js';
import { mapSdkModels } from '../server/agents/sdk-models.js';
import type { ModelOption } from '../server/agents/modelCatalog.js';

const require = createRequire(import.meta.url);
const sdkLib = path.dirname(require.resolve('@tencent-ai/agent-sdk'));

function loadSdk(file: string, overrides: Record<string, unknown> = {}) {
  const filename = path.join(sdkLib, file);
  const localRequire = createRequire(filename);
  const module = { exports: {} as any };
  vm.runInNewContext(readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __filename: filename, __dirname: path.dirname(filename),
    require: (id: string) => Object.hasOwn(overrides, id) ? overrides[id] : localRequire(id),
    process: { ...process, env: {}, platform: 'linux' },
    console, setTimeout, clearTimeout, AbortController,
  }, { filename });
  return module.exports;
}

await test('official product config owns endpoint and environment; fallback is preserved', () => {
  for (const endpoint of ['https://www.workbuddy.cn', 'https://www.workbuddy.ai']) {
    assert.deepEqual(planSdkRuntime({ endpoint, environment: 'external', hasProductConfig: true }),
      { reason: 'official-v3-config' });
    assert.equal(planSdkRuntime({ endpoint, environment: 'external' }).endpoint, endpoint);
  }
  assert.equal(planSdkRuntime({ environment: 'internal' }).environment, 'internal');
});

for (const mode of ['authenticated', 'initialize-error', 'start-error', 'login-success', 'login-failure', 'login-timeout']) {
  await test(`authenticate closes its transport: ${mode}`, async () => {
    let started = 0;
    let closed = 0;
    let handler: (request: unknown) => void;
    const failure = new Error(mode === 'start-error' ? 'spawn failed' : 'Request timeout: initialize');
    const transport = {
      start() { started++; if (mode === 'start-error') throw failure; },
      close() { closed++; },
      async sendControlRequest() {
        if (mode === 'initialize-error') throw failure;
        return mode === 'authenticated' ? { account: { userId: 'fixture-user', token: 'fixture-token' } } : {};
      },
      onControlRequest(callback: typeof handler) { handler = callback; },
      sendControlResponse() {},
      sendControlRequestNoWait() {
        if (mode === 'login-timeout') return;
        queueMicrotask(() => handler({
          request_id: 'fixture-result',
          request: {
            subtype: 'auth_result_callback', success: mode === 'login-success',
            userinfo: { userId: 'fixture-user' }, error: { type: 'auth_failed', message: 'fixture denied' },
          },
        }));
      },
    };
    const { authenticate } = loadSdk('auth.js', { './transport': { createTransport: () => transport } });
    const pending = authenticate({ onAuthUrl() { assert.fail('must not open a login URL'); }, timeout: 10 });
    if (mode === 'authenticated' || mode === 'login-success') {
      assert.equal((await pending).userinfo.userId, 'fixture-user');
    } else if (mode === 'start-error' || mode === 'initialize-error') {
      await assert.rejects(pending, (error: unknown) => error === failure);
    } else {
      await assert.rejects(pending, mode === 'login-timeout' ? /timed out/ : /fixture denied/);
    }
    assert.equal(started, 1);
    assert.equal(closed, 1);
  });
}

function transportHarness(version: () => Promise<string> = async () => 'fixture-version') {
  const children: Array<EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(): boolean }> = [];
  let killed = 0;
  const realUtils = require(path.join(sdkLib, 'utils/index.js'));
  const { ProcessTransport } = loadSdk('transport/process-transport.js', {
    'node:child_process': {
      spawn() {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
          kill() { killed++; child.emit('exit', 0); return true; },
        });
        children.push(child);
        return child;
      },
    },
    '../utils': { ...realUtils, resolveCLIVersion: version },
  });
  const transport = new ProcessTransport({ executablePath: 'fixture-cli.js', requestTimeoutMs: 10 });
  return {
    transport, children, killed: () => killed,
    dispose() {
      transport.close();
      for (const child of children) {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      }
    },
  };
}

await test('start is idempotent while open, but cannot resurrect a closed transport', () => {
  const h = transportHarness();
  try {
    h.transport.start();
    h.transport.start();
    assert.equal(h.children.length, 1);
    h.transport.close();
    assert.throws(() => h.transport.start(), { message: h.transport._closeReason ?? 'Transport closed' });
    h.transport.close();
    assert.equal(h.children.length, 1);
    assert.equal(h.killed(), 1);
    assert.equal(h.transport.process, null);
  } finally { h.dispose(); }
});

await test('closing an unused transport prevents its first spawn', () => {
  const h = transportHarness();
  try {
    h.transport.close();
    assert.throws(() => h.transport.start(), /Transport closed/);
    assert.equal(h.children.length, 0);
  } finally { h.dispose(); }
});

await test('ensureReady cannot report success on a previously ready, closed transport', async () => {
  const h = transportHarness();
  try {
    await h.transport.ensureReady();
    h.transport.close();
    await assert.rejects(h.transport.ensureReady(), { message: h.transport._closeReason ?? 'Transport closed' });
    assert.equal(h.children.length, 1);
  } finally { h.dispose(); }
});

await test('close during asynchronous version resolution prevents spawning', async () => {
  let release!: (version: string) => void;
  const version = new Promise<string>(resolve => { release = resolve; });
  const h = transportHarness(() => version);
  try {
    const pending = h.transport.ensureReady();
    h.transport.close();
    release('fixture-version');
    await assert.rejects(pending, /Transport closed/);
    assert.equal(h.children.length, 0);
  } finally { h.dispose(); }
});

await test('interrupt followed immediately by session.close does not spawn a replacement CLI', async () => {
  const h = transportHarness();
  try {
    const { SessionImpl } = loadSdk('session.js', { './transport': { createTransport: () => h.transport } });
    const session = new SessionImpl({ sessionId: 'fixture-session' });
    h.transport.start();
    session._initialized = true;
    h.transport.sendControlRequest = async () => { h.transport.start(); return {}; };
    const interrupt = session.interrupt();
    session.close();
    await interrupt;
    assert.equal(h.children.length, 1);
    assert.equal(h.transport.process, null);
  } finally { h.dispose(); }
});

// Execute the real loader in isolation, without importing the HTTP server or its startup hooks.
const indexPath = path.join(process.cwd(), 'server/index.ts');
const source = ts.createSourceFile(indexPath, readFileSync(indexPath, 'utf8'), ts.ScriptTarget.Latest, true);
const loaderNode = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'loadSdkModels');
assert.ok(loaderNode, 'loadSdkModels declaration must exist');
const loaderCode = ts.transpileModule(loaderNode.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function modelHarness(options: { raw?: 'success' | 'empty' | 'error'; thinError?: boolean; cached?: boolean; createError?: boolean; empty?: boolean } = {}) {
  const counts = { created: 0, raw: 0, thin: 0, closed: 0, cacheWrites: 0, probed: 0 };
  let models: ModelOption[] = options.cached ? [{ modelId: 'cached', name: 'Cached' }] : [];
  let defaultModel: string | undefined;
  const session = {
    async getAvailableModelsRaw() {
      counts.raw++;
      if (options.raw === 'error') throw new Error('raw unavailable');
      return options.raw === 'empty' || options.empty ? [] : [{ id: 'raw', name: 'Raw', isDefault: true }];
    },
    async getAvailableModels() {
      counts.thin++;
      if (options.thinError) throw new Error('thin unavailable');
      return options.empty ? [] : [{ modelId: 'thin', name: 'Thin' }];
    },
    close() { counts.closed++; },
  };
  const load = vm.runInNewContext(`${loaderCode}; loadSdkModels`, {
    console: { log() {}, warn() {} }, process: { cwd: () => 'fixture-workspace' },
    cachedModelsGetter: () => models, sdkDefaultGetter: () => defaultModel, defaultModel: 'default-model',
    _setSdkProbedAt() { counts.probed++; },
    _setSdkCache(next: ModelOption[], selected?: string) { models = next; defaultModel = selected; counts.cacheWrites++; },
    sdkRuntimeFor: () => ({}), mapSdkModels, readDeclaredModels: () => null,
    async unstable_v2_createSession() {
      counts.created++;
      if (options.createError) throw new Error('create failed');
      return session;
    },
  }) as (force?: boolean) => Promise<{ models: ModelOption[]; defaultModel?: string }>;
  return { load, counts };
}

for (const raw of ['success', 'empty', 'error'] as const) {
  await test(`model query closes its temporary session: raw=${raw}`, async () => {
    const h = modelHarness({ raw });
    const result = await h.load();
    assert.equal(result.models[0].modelId, raw === 'success' ? 'raw' : 'thin');
    assert.equal(h.counts.thin, raw === 'success' ? 0 : 1);
    assert.equal(h.counts.closed, 1);
    assert.equal(h.counts.cacheWrites, 1);
    if (raw === 'success') assert.equal(result.defaultModel, 'raw');
  });
}

await test('model query closes on fallback failure and preserves the original error', async () => {
  const h = modelHarness({ raw: 'error', thinError: true });
  await assert.rejects(h.load(), /thin unavailable/);
  assert.equal(h.counts.closed, 1);
  assert.equal(h.counts.cacheWrites, 0);
});

await test('empty model result still closes the session without caching an invented model', async () => {
  const h = modelHarness({ empty: true });
  assert.equal((await h.load()).models.length, 0);
  assert.equal(h.counts.closed, 1);
  assert.equal(h.counts.cacheWrites, 0);
});

await test('model cache hit creates no session; forced refresh closes its one new session', async () => {
  const h = modelHarness({ cached: true });
  assert.equal((await h.load()).models[0].modelId, 'cached');
  assert.equal(h.counts.created, 0);
  assert.equal(h.counts.probed, 0);
  assert.equal((await h.load(true)).models[0].modelId, 'raw');
  assert.equal(h.counts.created, 1);
  assert.equal(h.counts.closed, 1);
  assert.equal(h.counts.probed, 1);
});

await test('session creation failure is propagated without attempting to close a missing session', async () => {
  const h = modelHarness({ createError: true });
  await assert.rejects(h.load(), /create failed/);
  assert.equal(h.counts.closed, 0);
});
