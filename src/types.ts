/**
 * 本插件的消息来源声明。
 *
 * ⚠️ 关键：session format V4 **拒绝**退役的 `{ kind: 'plugin', plugin: '<name>' }` 包装。
 * 插件必须通过 declaration merging 声明**自己的** kind。
 * 模板来自 `packages/goal/goal/src/domain.ts:55-58`。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'goal-budget': {
      readonly kind: 'goal-budget'
      readonly goalId: string
      /** 触发这次提醒时的累计消费比例（0–1）。 */
      readonly ratio: number
    }
  }
}

export {}
