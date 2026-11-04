/**
 * 本插件依赖的 DSH 接口 —— **显式清单**。
 *
 * ## 为什么不用 `@deepseek-ai/*` 的包
 *
 * 这些包由**宿主**提供（`peerDependencies`），插件在运行时不需要装它们。
 * 构建期指向源码会拖进整条依赖链（cosmokit / standard-schema / …）并级联报错。
 *
 * 所以这里只声明**本插件真正用到的那一小部分**，并标注每条的出处。
 * 这份文件因此有两个作用：类型检查 + **依赖审计**（多了什么一眼看得出）。
 *
 * ## 出处
 * 全部来自 `deepseek-ai/deepseek-harness` master @ 8bd07339。
 */

// ─────────────────────────────────────────────────────────────
// @deepseek-ai/schemastery
// 官方 140 个包用 `import z from '@deepseek-ai/schemastery'`（统计所得）。
// 这里只声明本插件用到的构造子。
// ─────────────────────────────────────────────────────────────
declare module '@deepseek-ai/schemastery' {
  interface Schema<T> {
    /** 默认值；同时把该字段变为可选。 */
    default(value: T): Schema<T>
  }

  /** 从 Schema 取出它描述的类型 —— 等价于官方的 `z.infer<S>`。 */
  type Infer<S> = S extends Schema<infer T> ? T : never

  interface Schemastery {
    /** ★ 关键是这里把每个字段的 Schema 拆成它的值类型，否则得到的是 Schema 的 Schema。 */
    object<T extends Record<string, Schema<unknown>>>(
      shape: T,
    ): Schema<{ [K in keyof T]: Infer<T[K]> }>
    number(): Schema<number>
    string(): Schema<string>
    boolean(): Schema<boolean>
    union<T extends readonly Schema<unknown>[]>(variants: T): Schema<Infer<T[number]>>
    const<T extends string | number | boolean>(value: T): Schema<T>
  }

  const z: Schemastery
  export default z
  export type { Infer }
}

// ─────────────────────────────────────────────────────────────
// @deepseek-ai/dsh-llm —— 只用到 TokenUsage 和 MessageSourceMap
// 出处：packages/llm/llm/src/types.ts:182 / message.ts:110
// ─────────────────────────────────────────────────────────────
declare module '@deepseek-ai/dsh-llm' {
  /** 出处：packages/llm/llm/src/types.ts:182 */
  export interface TokenUsage {
    inputTokens: number
    outputTokens: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }

  /**
   * 消息来源映射 —— **合并可扩展**。
   *
   * 出处：packages/llm/llm/src/message.ts:110
   * 官方要求（docs/cookbook/adding-a-tool.md:49）：
   *   插件必须通过 declaration merging 声明**自己的** kind；
   *   session format V4 拒绝退役的 `{ kind: 'plugin', plugin: '<name>' }` 包装。
   *
   * 模板来自 packages/goal/goal/src/domain.ts:55-58。
   */
  export interface MessageSourceMap {
    user: { kind: 'user' }
    model: { kind: 'model'; provider: string; model: string }
    tool: { kind: 'tool'; toolCallId: string }
    'system-prompt': { kind: 'system-prompt' }
    [extension: string]: { kind: string }
  }
}

// ─────────────────────────────────────────────────────────────
// @deepseek-ai/dsh-session
// 出处：packages/core/session/src/types.ts
// ─────────────────────────────────────────────────────────────
declare module '@deepseek-ai/dsh-session' {
  /** 出处：packages/core/session/src/types.ts:501 */
  export type SessionEvent<T extends string = string> = {
    type: T
    seq: number
    time: number
    data: unknown
  }

  export interface Session {
    readonly id: string
  }
}

// ─────────────────────────────────────────────────────────────
// @deepseek-ai/dsh-goal
// 出处：packages/goal/goal/src/domain.ts:47 / docs/subsystems/goal.md
// ─────────────────────────────────────────────────────────────
declare module '@deepseek-ai/dsh-goal' {
  /** 出处：packages/goal/goal/src/domain.ts:47 */
  export interface GoalMessageSource {
    readonly kind: 'goal'
    readonly goalId: string
    readonly revision: number
    /** Positive admitted continuation round. `0` 是人工创建 goal 的那条消息。 */
    readonly round: number
  }

  /**
   * 出处：docs/subsystems/goal.md（GoalBlockReason）
   * `code` 是开放的 string，注释写明 **chosen by the blocking policy** ——
   * 这就是插件注册自己 code 的正式入口。
   */
  export interface GoalBlockReason {
    readonly code: string
    readonly message: string
  }

  export interface GoalRef {
    readonly id: string
    readonly revision: number
  }
}

// ─────────────────────────────────────────────────────────────
// @deepseek-ai/dsh-agent
// 出处：packages/core/agent/src/runtime-types.ts:328
// ─────────────────────────────────────────────────────────────
declare module '@deepseek-ai/dsh-agent' {
  /** 出处：packages/core/agent/src/runtime-types.ts:328 */
  export interface AgentInboxClaimedPayload {
    readonly agent: unknown
    readonly message: { readonly source: { readonly kind: string } }
    /** ★ 唯一能把消息关联到 turn 的字段。 */
    readonly turn: number
  }
}
