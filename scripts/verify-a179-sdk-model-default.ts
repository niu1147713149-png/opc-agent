/**
 * A179：WorkBuddy / Tencent SDK 的默认模型与失效模型回退。
 *
 * 钉死三件事：
 *   1. `/api/models` 的兜底只给 SDK 默认别名，不再出现已下线的具体型号；
 *   2. 没有显式模型时使用当前清单的默认项，不硬塞旧 Auto 别名；
 *   3. 旧会话里已下线的模型名在发请求前回退到当前默认项。
 *
 * 运行：npx tsx scripts/verify-a179-sdk-model-default.ts
 */
// 必须先于所有 server/** import：把 OPC_DATA_DIR 指向临时目录，绝不触碰真实 data/
import './lib/temp-data-dir.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  prepareModelForAgent,
  resolveModelForAgent,
  resolveStoredModelForAgent,
  isStaleSdkModel,
  setPlatformModelLookup,
  setConfiguredModelLookup,
  SDK_DEFAULT_MODEL,
  SDK_MODEL_FALLBACK,
  PLATFORM_DEFAULT_MODEL,
} from '../server/model-routing.js';
import type { AgentEvent, SendContext } from '../server/agents/types.js';
import type { RunEvent } from '../shared/blocks.js';

const root = path.resolve(import.meta.dirname, '..');
const failures: string[] = [];
let total = 0;

function eq<T>(actual: T, expected: T, label: string) {
  total++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}\n      实际: ${a}\n      期望: ${e}`);
}

function ok(cond: boolean, label: string, detail?: string) {
  total++;
  if (!cond) failures.push(detail ? `${label} —— ${detail}` : label);
}

// ── 1. 兜底清单：只允许 SDK 默认别名 ──────────────────────────────
{
  eq(SDK_MODEL_FALLBACK, [{ modelId: 'default-model', name: 'Auto' }], '兜底清单应只有 default-model / Auto');
  ok(!JSON.stringify(SDK_MODEL_FALLBACK).includes('claude-sonnet-4'), '兜底清单不得含 claude-sonnet-4');
  ok(!JSON.stringify(SDK_MODEL_FALLBACK).includes('claude-opus-4'), '兜底清单不得含 claude-opus-4');
}

// ── 2. 清单未知时不能凭空指定旧默认别名 ──────────────────────────
{
  eq(resolveModelForAgent('workbuddy', undefined), undefined, '清单未知时不猜默认模型');
  eq(resolveModelForAgent('workbuddy', ''), undefined, '空串应视作未指定');
  ok(PLATFORM_DEFAULT_MODEL === 'claude-sonnet-4', '旧平台常量保留，仅作历史值过滤哨兵');
}

// ── 3. 清单就绪后：有效值沿用、失效值回退 ────────────────────────
{
  setPlatformModelLookup(() => ['default-model', 'hy3', 'deepseek-v4.1-flash']);

  eq(resolveModelForAgent('workbuddy', 'hy3'), 'hy3', '清单内的显式模型应原样采用');
  eq(resolveStoredModelForAgent('workbuddy', 'hy3'), 'hy3', '旧会话里的有效模型应沿用');
  eq(resolveStoredModelForAgent('workbuddy', 'default-model'), 'default-model', '旧会话里的默认别名应沿用');

  eq(isStaleSdkModel('workbuddy', 'claude-sonnet-4'), true, 'claude-sonnet-4 应判定为失效');
  eq(isStaleSdkModel('workbuddy', 'claude-opus-4'), true, 'claude-opus-4 应判定为失效');
  eq(
    resolveStoredModelForAgent('workbuddy', 'claude-sonnet-4'),
    SDK_DEFAULT_MODEL,
    '旧会话失效模型应回退清单内的默认模型'
  );
  eq(
    resolveStoredModelForAgent('workbuddy', 'claude-opus-4'),
    SDK_DEFAULT_MODEL,
    '另一个失效旧模型也应回退当前默认模型'
  );
  eq(resolveStoredModelForAgent('workbuddy', undefined), 'default-model', '旧会话没有模型时仍走 SDK 默认');

  // 非 Tencent SDK 不受这份清单影响（claude 自己的命名空间另有规则）
  eq(isStaleSdkModel('claude', 'claude-opus-4'), false, '非 Tencent SDK 不做失效判定');
  eq(resolveStoredModelForAgent('hermes', PLATFORM_DEFAULT_MODEL), undefined, 'ACP 仍拦截旧平台默认值');

  // 清单未就绪时不能乱丢用户显式选择
  setPlatformModelLookup(() => null);
  eq(isStaleSdkModel('workbuddy', 'claude-sonnet-4'), false, '清单未就绪时不做失效判定');
  eq(resolveStoredModelForAgent('workbuddy', 'claude-sonnet-4'), 'claude-sonnet-4', '清单未就绪时应原样沿用');
  setPlatformModelLookup(null);
}

// 群聊没有单一模型，旧 Auto 别名也可能已不在当前账号的清单中。
{
  const models = ['fast-model', 'hy4flash-free', 'deep-model'];
  setPlatformModelLookup(() => models, { defaultModel: () => 'hy4flash-free' });
  eq(resolveModelForAgent('workbuddy', undefined), 'hy4flash-free', '群聊缺省应使用 SDK 声明的默认模型');
  eq(resolveModelForAgent('workbuddy', SDK_DEFAULT_MODEL), 'hy4flash-free', '旧 Auto 占位符应解析成当前默认模型');
  eq(resolveStoredModelForAgent('workbuddy', SDK_DEFAULT_MODEL), 'hy4flash-free', '旧群聊中的 Auto 不能继续发送');
  eq(resolveStoredModelForAgent('workbuddy', 'retired-model'), 'hy4flash-free', '下线模型回退到可用默认项');
  eq(resolveStoredModelForAgent('workbuddy', 'fast-model'), 'fast-model', '显式有效选择不被默认值覆盖');
  setConfiguredModelLookup((id, model) => id === 'workbuddy' && model === 'custom-local:fixture');
  eq(resolveStoredModelForAgent('workbuddy', 'custom-local:fixture'), 'custom-local:fixture', '本机自定义模型不被默认值覆盖');
  setConfiguredModelLookup(null);
  eq(resolveStoredModelForAgent('codex', undefined), undefined, 'Codex 不接收 WorkBuddy 的默认模型');
  eq(resolveStoredModelForAgent('codex', SDK_DEFAULT_MODEL), undefined, '旧群聊 Auto 占位符不传给 Codex');
  eq(resolveStoredModelForAgent('claude', SDK_DEFAULT_MODEL), undefined, '旧群聊 Auto 占位符不传给 Claude');

  setPlatformModelLookup(() => models, { defaultModel: () => 'retired-model' });
  eq(resolveStoredModelForAgent('workbuddy', undefined), 'fast-model', '失效默认元数据回退到清单内的首项');
  setPlatformModelLookup(() => models);
  eq(resolveStoredModelForAgent('workbuddy', SDK_DEFAULT_MODEL), 'fast-model', 'thin 清单没有默认标记时仍选清单内模型');
  setPlatformModelLookup(() => [SDK_DEFAULT_MODEL, ...models], { defaultModel: () => 'hy4flash-free' });
  eq(resolveStoredModelForAgent('workbuddy', SDK_DEFAULT_MODEL), SDK_DEFAULT_MODEL, '账号仍支持 Auto 时保留用户的显式选择');
  setPlatformModelLookup(null);
}

// 冷启动、并发加载、失败后的重试均不能依赖 UI 先打开模型菜单。
{
  let models: string[] | null = null;
  let loads = 0;
  setPlatformModelLookup(() => models, {
    defaultModel: () => 'hy4flash-free',
    load: async () => { loads++; models = ['fast-model', 'hy4flash-free']; },
  });
  await prepareModelForAgent('codex');
  await prepareModelForAgent('claude');
  eq(loads, 0, '非 Tencent 成员不触发 WorkBuddy 清单加载');
  await Promise.all([prepareModelForAgent('workbuddy'), prepareModelForAgent('workbuddy')]);
  eq(loads, 1, '冷启动并发派发共用一次清单加载');
  eq(resolveStoredModelForAgent('workbuddy'), 'hy4flash-free', '冷启动加载后采用 SDK 默认值');
  await prepareModelForAgent('workbuddy');
  eq(loads, 1, '热缓存不增加额外清单请求');

  models = null;
  await prepareModelForAgent('workbuddy');
  eq(loads, 2, '清单失效后重新加载');
  models = null;
  let failLoad = true;
  setPlatformModelLookup(() => models, {
    load: async () => {
      if (failLoad) throw new Error('fixture failure');
      models = ['fast-model'];
    },
  });
  let rejected = false;
  try { await prepareModelForAgent('workbuddy'); } catch { rejected = true; }
  ok(rejected, '默认模型清单加载失败时明确报错，不继续发出旧别名');
  await prepareModelForAgent('workbuddy', 'custom-local:fixture');
  eq(resolveStoredModelForAgent('workbuddy', 'custom-local:fixture'), 'custom-local:fixture', '加载失败不丢弃显式自定义模型');
  failLoad = false;
  await prepareModelForAgent('workbuddy');
  eq(resolveStoredModelForAgent('workbuddy'), 'fast-model', '失败后可以重试，不缓存 rejected promise');

  setPlatformModelLookup(() => [], { load: async () => {} });
  rejected = false;
  try { await prepareModelForAgent('workbuddy', SDK_DEFAULT_MODEL); } catch { rejected = true; }
  ok(rejected, '空清单不把 Auto 占位符当作有效显式选择');
  setPlatformModelLookup(null);
}

// 使用真实编排器、turn-runner、投影器和临时数据库，仅替换模型调用。
{
  const db = await import('../server/db.js');
  const { registry } = await import('../server/agents/registry.js');
  const { createTurnRunner } = await import('../server/turn-runner.js');
  const { runOrchestration } = await import('../server/orchestrator.js');
  const originalStream = registry.stream;
  try {
    for (const scenario of [
      { name: '新群聊冷启动', mode: 'dispatch' as const, stored: '', expected: 'hy4flash-free' },
      { name: '旧群聊 Auto', mode: 'dispatch' as const, stored: SDK_DEFAULT_MODEL, expected: 'hy4flash-free' },
      { name: '广播模式', mode: 'broadcast' as const, stored: '', expected: 'hy4flash-free' },
      { name: '保留显式选择', mode: 'dispatch' as const, stored: '', requested: 'fast-model', expected: 'fast-model' },
    ]) {
      let models: string[] | null = null;
      let loads = 0;
      setPlatformModelLookup(() => models, {
        defaultModel: () => 'hy4flash-free',
        load: async () => { loads++; models = ['fast-model', 'hy4flash-free']; },
      });
      const calls: Array<{ id: string; ctx: SendContext }> = [];
      registry.stream = (id, ctx) => {
        calls.push({ id, ctx });
        return (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'text', content: id === 'codex' ? 'ROUTE: workbuddy' : 'WB_OK' };
          yield { type: 'done', durationMs: 1 };
        })();
      };
      const now = new Date().toISOString();
      const session = db.createSession({
        id: randomUUID(), title: scenario.name, model: scenario.stored,
        agent_id: null, sdk_session_id: null, kind: 'group',
        agent_ids: JSON.stringify(['codex', 'workbuddy']), orchestration: scenario.mode,
        cwd: null, reasoning_effort: null, scenario_id: null, system_prompt: null,
        created_at: now, updated_at: now,
      });
      const events: RunEvent[] = [];
      const turn = createTurnRunner({
        session, model: scenario.requested, signal: new AbortController().signal,
        emitBlocks: batch => events.push(...batch),
      });
      await runOrchestration({ mode: scenario.mode, members: ['codex', 'workbuddy'], prompt: 'hello' }, {
        runAgent: turn.runAgent, note: () => {}, displayName: id => id, isUsable: () => true,
      });
      eq(loads, 1, `${scenario.name}：派发时加载一次清单`);
      eq(calls.find(c => c.id === 'workbuddy')?.ctx.model, scenario.expected, `${scenario.name}：适配器拿到正确模型`);
      ok(calls.find(c => c.id === 'workbuddy')?.ctx.prompt.endsWith('【当前用户请求】\n\nhello') === true,
        `${scenario.name}：当前请求在知识库参考区之外，且原文完整保留`);
      const saved = db.getMessagesBySession(session.id).find(m => m.author_agent_id === 'workbuddy');
      eq(saved?.model, scenario.expected, `${scenario.name}：落库模型与派发一致`);
      eq(saved?.content, 'WB_OK', `${scenario.name}：正文落库一次`);
      ok(events.some(e => e.type === 'run_start' && e.agentId === 'workbuddy' && e.model === scenario.expected), `${scenario.name}：SSE 模型与派发一致`);
      eq(turn.activeRuns.size, 0, `${scenario.name}：所有执行已收尾`);
      if (!scenario.requested) {
        ok(calls.filter(c => c.id === 'codex').every(c => c.ctx.model === undefined), `${scenario.name}：Codex 不收到 WorkBuddy 默认模型`);
      }
    }
  } finally {
    registry.stream = originalStream;
    registry.disposeAll();
    setPlatformModelLookup(null);
  }
}

// ── 4. 源码契约：入口与兜底不能再写旧型号 ────────────────────────
{
  const index = readFileSync(path.join(root, 'server/index.ts'), 'utf8');
  const runner = readFileSync(path.join(root, 'server/turn-runner.ts'), 'utf8');

  ok(!index.includes('"claude-sonnet-4"'), 'server/index.ts 不得再硬编码 claude-sonnet-4');
  ok(!index.includes('"claude-opus-4"'), 'server/index.ts 不得再硬编码 claude-opus-4');
  ok(index.includes('SDK_MODEL_FALLBACK'), '/api/models 兜底必须走 SDK_MODEL_FALLBACK');
  ok(index.includes('const defaultModel = SDK_DEFAULT_MODEL'), 'defaultModel 初值必须是 SDK 默认别名');
  ok(index.includes('resolveStoredModelForAgent'), '发消息路由必须走失效模型回退');
  ok(runner.includes('resolveStoredModelForAgent'), 'turn-runner 必须走失效模型回退');
  ok(!runner.includes('resolveModelForAgent('), 'turn-runner 不得绕过失效模型回退');
}

console.log(`A179 结果：通过 ${total - failures.length}，失败 ${failures.length}`);
if (failures.length) {
  console.log('\n✗ 失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('✓ SDK 默认模型、兜底清单与旧会话失效模型回退均符合预期');
