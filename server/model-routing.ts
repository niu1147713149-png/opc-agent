/**
 * 模型路由：决定「这次调用该把哪个模型名交给这个 Agent」。
 *
 * 为什么需要独立一层：模型名是**各 Agent 私有的命名空间**，不能跨 Agent 复用。
 *   - WorkBuddy SDK 使用其当前清单声明的默认模型
 *   - opencode 认 `zai/glm-4.7`（provider/model 形式）
 *   - codex 认 `gpt-5.4`
 *   - hermes（ACP）由会话自己选
 *
 * 旧的平台默认模型（`claude-sonnet-4`）只对当时的 SDK 类有意义，现在已经
 * 不在 WorkBuddy 的模型清单里。把这种值塞给 opencode 会直接触发
 * `Error: Invalid model reference` —— 实测会让 opencode 完全不可用，
 * 而且报错发生在 Agent 内部，看起来像 Agent 坏了而不是参数传错了。
 *
 * 所以这里做三件事：
 *   1. Tencent SDK：沿用有效请求值；缺省或旧值失效时用当前清单的默认模型
 *   2. 声明了 models 白名单的：请求值命中才采用，否则回退该 Agent 自己的默认值
 *   3. 其余：只在请求值不是旧平台默认模型时才透传
 */

import { findDef } from './agents/definitions.js';

/**
 * 旧平台默认模型。**仅作为历史遗留值的过滤哨兵**，不再作为任何 Agent 的默认值。
 *
 * 会话库/前端 localStorage 里可能还存着它；非 Tencent SDK 的 Agent 收到这个
 * 名字会直接报非法模型，所以透传分支必须把它拦下来。
 */
export const PLATFORM_DEFAULT_MODEL = 'claude-sonnet-4';

/** Tencent SDK 的历史 Auto 别名；是否仍可用必须以当前清单为准。 */
export const SDK_DEFAULT_MODEL = 'default-model';

/**
 * SDK 清单不可用时 `/api/models` 的 Auto 占位项，不代表账号支持该别名。
 * 真正发送前会重新加载清单并解析默认值，不硬编码具体型号。
 */
export const SDK_MODEL_FALLBACK: ReadonlyArray<{ modelId: string; name: string }> = [
  { modelId: SDK_DEFAULT_MODEL, name: 'Auto' },
];

/**
 * 当前 SDK 模型清单的只读查询（由 `index.ts` 在清单加载后注册）。
 *
 * 返回 `null` / 空列表 = 清单还没拿到，此时不做「失效模型」判断 ——
 * 不能因为一次加载失败就把用户显式选的模型丢掉。
 */
export type PlatformModelLookup = () => readonly string[] | null;

let platformModelLookup: PlatformModelLookup | null = null;
interface PlatformModelOptions {
  defaultModel?: () => string | undefined;
  load?: () => Promise<unknown>;
}
let platformModelOptions: PlatformModelOptions = {};
let platformModelLoad: Promise<unknown> | null = null;

export function setPlatformModelLookup(fn: PlatformModelLookup | null, options: PlatformModelOptions = {}): void {
  platformModelLookup = fn;
  platformModelOptions = options;
  platformModelLoad = null;
}

function usesPlatformCatalog(agentId: string): boolean {
  const def = findDef(agentId);
  return def?.descriptor.kind === 'sdk' && (def.sdk?.provider ?? 'tencent') === 'tencent';
}

/** 首次派发不依赖用户先打开模型菜单；并行群聊共用一次清单加载。 */
export async function prepareModelForAgent(agentId: string, requested?: string | null): Promise<void> {
  if (!usesPlatformCatalog(agentId) || platformModelLookup?.()?.length || !platformModelOptions.load) return;
  const explicit = !!requested && requested !== SDK_DEFAULT_MODEL && requested !== PLATFORM_DEFAULT_MODEL;
  const pending = platformModelLoad ??= Promise.resolve().then(platformModelOptions.load);
  try {
    await pending;
    if (!platformModelLookup?.()?.length && !explicit) throw new Error('empty model catalog');
  } catch {
    // 清单临时不可用不能阻断用户已指定的模型；缺省时则不能捏造旧 Auto 别名。
    if (!explicit) throw new Error(`无法读取 ${agentId} 的模型清单，请刷新清单或手动指定模型后重试。`);
  } finally {
    if (platformModelLoad === pending) platformModelLoad = null;
  }
}

function currentSdkDefaultModel(): string | undefined {
  const models = platformModelLookup?.();
  if (!models?.length) return undefined;
  const preferred = platformModelOptions.defaultModel?.();
  if (preferred && models.includes(preferred)) return preferred;
  return models.includes(SDK_DEFAULT_MODEL) ? SDK_DEFAULT_MODEL : models[0];
}

/**
 * 「这个模型是否属于该 Agent 的动态目录」的查表函数。
 *
 * 为什么用注入而不是直接 import `modelCatalog`：目录模块要读 `data/` 路径、
 * 会拉起 CLI 子进程，而本文件是**纯判定逻辑**，被离线验证脚本直接调用。
 * 反过来 import 会把这些副作用带进 `verify:routing`（顺带打开真实数据库）。
 * 由 `index.ts` 在启动时把 `isCatalogModel` 注册进来。
 */
export type CatalogModelLookup = (agentId: string, modelId: string) => boolean;

let catalogLookup: CatalogModelLookup | null = null;

/** 注册/清除动态目录查表（传 null 可复位，供测试使用） */
export function setCatalogModelLookup(fn: CatalogModelLookup | null): void {
  catalogLookup = fn;
}

/**
 * 「这个模型名是不是用户在**本机 CLI 配置里自己写的**」的查表函数（A210）。
 *
 * 为什么又是一层注入：跟 `catalogLookup` 同一个理由 —— 扫描配置文件要读
 * `~/.claude` / `~/.codex` / `~/.config/opencode`，而本文件是纯判定逻辑，
 * 被 `verify:routing` 这类离线脚本直接调用，不该带上文件系统副作用。
 * 由 `index.ts` 启动时注册一份带 TTL 缓存的实现。
 *
 * 用途：有 `def.models` 白名单的 Agent（opencode 等）会把不在白名单、
 * 也不在动态目录里的名字静默换成默认模型。用户在 CLI 里配了自定义网关
 * 的模型名，正是「不在白名单但确实能跑」的一类 —— 不放行就等于菜单能选、
 * 发出去却被换掉，是典型假控件。
 */
export type ConfiguredModelLookup = (agentId: string, modelId: string) => boolean;

let configuredLookup: ConfiguredModelLookup | null = null;

/** 注册/清除本机配置模型查表（传 null 可复位，供测试使用） */
export function setConfiguredModelLookup(fn: ConfiguredModelLookup | null): void {
  configuredLookup = fn;
}

/**
 * 解析要传给某个 Agent 的模型。
 *
 * @param agentId   Agent 标识
 * @param requested 调用方（前端 / 编排层 / 会话记录）给的模型名
 * @returns 要传给 Agent 的模型；`undefined` 表示「交给 Agent 自己决定」
 */
export function resolveModelForAgent(
  agentId: string,
  requested?: string | null
): string | undefined {
  const def = findDef(agentId);
  if (!def) return requested || undefined;

  // A156：只有 Tencent SDK（CodeBuddy / WorkBuddy）才吃平台模型清单。
  // claude / codex 虽然也是 kind='sdk'，但模型名属于各自厂商的命名空间，
  // 把 `claude-sonnet-4` 塞给它们会被当成非法模型。它们的 cli 规格仍在，
  // 所以继续走下面的白名单 / 透传分支，与改造前行为一致。
  if (usesPlatformCatalog(agentId)) {
    if (requested && (requested !== SDK_DEFAULT_MODEL || platformModelLookup?.()?.includes(requested))) return requested;
    return currentSdkDefaultModel();
  }

  const allowed = def.models;
  if (allowed && allowed.length > 0) {
    if (requested && allowed.includes(requested)) return requested;
    // 动态目录里的模型同样是真的能跑的（清单由 CLI 自己枚举出来）。
    // 不认这一条，用户在模型菜单里选了 `opencode/glm-5.3-flash-free`
    // 会被静默换成默认模型 —— 菜单看起来能选，实际没生效。
    if (requested && catalogLookup?.(agentId, requested)) return requested;
    // A210：本机 CLI 配置里用户自己写的模型名（自定义网关 / 第三方 provider）。
    // 白名单里没有它是正常的 —— 它本来就不是厂商官方目录的一员。
    // 不放行就会静默退回默认模型，界面却显示「已选中」。
    if (requested && configuredLookup?.(agentId, requested)) return requested;
    return def.defaultModel ?? allowed[0];
  }

  // 没有白名单可依据：拦住旧平台默认值及 Tencent Auto 占位符。
  // 会话里存的模型也可能是修复前的历史遗留值，所以这一步不能省。
  if (!requested || requested === PLATFORM_DEFAULT_MODEL || requested === SDK_DEFAULT_MODEL) return undefined;
  return requested;
}

/**
 * 这个值是否是「Tencent SDK 清单里已经没有的旧模型」。
 *
 * 旧会话的 `session.model` 可能存着 `claude-sonnet-4` 这类已下线的名字；
 * 如果原样发出去，CLI 会在真正请求时才报模型不存在。这里在发请求前拦下。
 *
 * 返回 false 的两种情况要分清：清单未就绪（不猜）、模型确实在清单里。
 */
export function isStaleSdkModel(agentId: string, modelId?: string | null): boolean {
  if (!modelId) return false;
  if (!usesPlatformCatalog(agentId)) return false;
  const list = platformModelLookup?.();
  if (!list || list.length === 0) return false;
  if (list.includes(modelId)) return false;
  // A211：WorkBuddy 桌面端「自定义模型」不在 SDK 的平台清单里，但 SDK 的
  // `setModel()` 确实认它（端点与密钥由官方 SDK 从自己的数据根读取）。
  // 模型菜单里选了它、当前轮能跑，下一轮 `resolveStoredModelForAgent()`
  // 却会因为「不在平台清单」把它判成已下线的旧模型并静默抹掉 —— 典型
  // 「第一次能用、刷新就没了」。这里放行本机配置里登记过的名字。
  if (configuredLookup?.(agentId, modelId)) return false;
  return true;
}

/**
 * 解析「会话里存着的模型」——turn-runner 的唯一入口。
 *
 * 失效的旧 SDK 模型名回退到当前清单的默认项，不能重新使用已下线的别名。
 */
export function resolveStoredModelForAgent(
  agentId: string,
  stored?: string | null
): string | undefined {
  if (isStaleSdkModel(agentId, stored)) return resolveModelForAgent(agentId);
  return resolveModelForAgent(agentId, stored);
}
