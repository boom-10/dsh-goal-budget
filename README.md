# dsh-goal-budget

> 给 DSH 的长任务目标设一个 token / 费用上限。**超了就把它停下** —— 不是只给你看个数字。

![点开 pill 后的花费明细](docs/panel.png)

<p align="center"><sub>点开输入框右下角的 pill，是本会话的花费明细。数据由宿主计算，与阻断判定同源。</sub></p>

**其他语言 / Other languages:** [English](README.en.md)

---

## 一句话说清它和别的插件的区别

DSH 生态里已经有 40+ 个插件能告诉你 **「我花了多少钱」**。
这个插件回答的是 **「这个目标还该不该继续跑」** —— 并且**对答案采取行动**。

```ts
ctx.goals.block(agent, { id, revision }, {
  code: 'budget-exceeded',
  message: '目标超出配置的 token 预算：5200 / 100',
})
```

**这个区别不是修辞。** 一个显示错了你只是看到个错数字；**一个执行的闸门错了，会杀掉本来就要成功的工作。** 不同的问题，不同的失败模式（见 [失败模式](#失败模式)）。

---

## 为什么这个缺口是真实存在的

不是猜的。DSH 自带目标自动续跑驱动，**它自己的 README 就点名了三件它不做的事**：

> **Round cap, not resource budget** — token, currency, time, and provider quota policies remain independent. Their session events are **not attributed to the goal message** or **mapped into goal blocker codes**.
>
> — `packages/goal/goal-round-driver/README.md`，*Known Limitations and Deferred Work*

这句话点了三块缺失。这个插件补了其中两块：

| 官方点名的缺口 | 状态 |
| --- | --- |
| 会话事件**没有归因到目标消息** | ✅ 已做，按 `goalId` + `round` 归因 |
| 没有**映射成目标的阻断码** | ✅ 已做，`code: 'budget-exceeded'` |
| 墙钟时间预算 | ⬜ 尚未实现 |

`GoalBlockReason.code` 是一个开放的 `string`，官方文档说它由 *"the blocking policy"* 决定 —— **它存在就是为了让策略插件给自己的条件命名**。目前树内只随附两个码（`model-reported`、`round-limit`），这里补上第三个。

---

## 安装

```sh
dsh plugin --profile desktop add github:boom-10/dsh-goal-budget
```

装完**重启 DSH**（插件的宿主半边和客户端半边都在启动时加载）。

`dsh plugin` 会把参数转发给 profile 目录里的 `pnpm`，所以 git 引用、本地路径都能用。

> **从本地路径安装时**，pnpm 会警告 `peerDependencies` 无法从目标 `node_modules` 解析。**这个警告在这里是预期的** —— `@deepseek-ai/cordis` 和 `@deepseek-ai/schemastery` 由宿主在运行时提供。介意的话用 `file:` 协议。

**不配任何预算也能装** —— 插件会加载并空转，等你用 `/budget` 设一个。

---

## 用法

### 一、在会话里设上限

**在输入框直接打命令，不用改 YAML、不用重启：**

```
/budget            查看当前生效的上限和已用量
/budget $5         本会话费用上限 5 美元
/budget 500k       本会话 token 上限 50 万
/budget $5 500k    两个都设，谁先到算谁
/budget off        清掉会话覆盖，回到 profile 默认
```

预算按 **会话覆盖 ?? profile 默认** 解析 —— 所以「固定的额度」可以写在配置里，「临时收紧一次」只要在输入框打一行。

### 二、在 pill 上看进度

装好后，输入框右下角的状态条里会多出一个 pill —— 就在宿主自己的「缓存命中」「上下文占用」旁边：

![输入框状态条里的 pill](docs/pill.png)

<p align="center"><sub>最右边那个 <code>● $2.49</code> 就是本插件。左边是宿主自己的指标，右边是上下文占用。</sub></p>

点它，展开明细（走宿主的原语，所以外观、键盘可达性、点击外部关闭都和官方 pill 一致）：

```
┌──────────────────────────────┐
│ 目标预算                 50% │
│ ──────────────────────────── │
│ 已花费                 $2.49 │
│ Token                  3.89m │
│ 上限                     $5  │
│ 先到                    费用 │
│ 由宿主计价，与预算判定同一套算法 │
└──────────────────────────────┘
```

**设了上限之后**，标题栏右侧会出现使用百分比，pill 上的进度条会跟着走 —— 到 80% 转琥珀，100% 转红。

**文案跟随 DSH 的语言设置** —— 界面是中文，pill 就是中文。

### 三、或者作为 profile 默认

想给所有会话一个固定额度：

```yaml
- id: dsh-goal-budget
  config:
    budget:
      tokens: 2000000
      costUsd: 5.00
    onExceed: block        # 或 'warn'，只记日志不阻断
    warnAtRatio: 0.8
    pricing:
      inputPerMillion: 0.15
      outputPerMillion: 0.60
      cacheReadPerMillion: 0.003
```

**为什么坚持做两层：** 预算是**运行时决策**（每个会话都可能不同），而插件配置是**部署决策**（启动时读取）。把预算只放在配置里，意味着为了改一个你当场决定的值要重启应用。

---

## 和已有的用量插件有什么不同

生态里报告花费的插件已经饱和了，而且**全是只读的**：

| 插件 | ⭐ | 它做什么 |
| --- | --- | --- |
| `@kenz1117/dsh-ui-usage-billing` | 95 | 用量账单**看板**、侧边栏成本指标 |
| `dsh-mimo-quota` | 0 | 从会话事件日志**查看**用量与估算花费 |
| `dsh-credits` | 3 | **跟踪**供应商余额、套餐额度、会话成本 |
| `dsh-composer-balance` | 0 | **显示**账户余额与本会话估算成本 |
| `dsh-web-api-balance` | 1 | **展示** API 余额与本次对话花费 |

**它们回答「我花了多少」。这个插件回答「该不该继续」——并且执行这个答案。**

---

## 设计

### 花费怎么归因到目标

有两个事实让归因成为可能，而**只有一个事件同时携带两者**：

```ts
// packages/core/session/src/types.ts:355 —— 花费落在这里，按 turn 索引
'assistant/message': { turn: number; step: number; usage?: TokenUsage; … }

// packages/core/agent/src/runtime-types.ts:328 —— 唯一把消息和 turn 连起来的事件
'agent/inbox/claimed'(payload: { agent; message: UserMessage; turn: number }): void
```

**`user/message` 不携带 `turn`** —— 它的载荷只是一个 `UserMessage`。光靠事件顺序会把每个 `agent.inject()` 的上下文块都误读成一"轮"。`agent/inbox/claimed` 是**唯一**把消息和它所开启的 turn 配对的事件，而 `message.source` 能识别自动续跑：

```ts
source: { kind: 'goal', goalId, revision, round }   // round > 0 = 自动续跑的轮次
```

所以链条是：

```
agent/inbox/claimed   source.kind === 'goal'  →  记住 turn → { goalId, round }
        ↓
assistant/message     { turn, usage }         →  累加到该目标的该轮
        ↓
checkBudget()                                 →  超了？→ ctx.goals.block()
```

归因**完全从会话日志重建**，从不另存一份 —— 所以重启不会重复计费，也不会清零。

### 一个数字，一个来源

**pill 不自己算钱。** 它读的是**闸门用的同一个投影**，所以你看到的数和阻断判定用的数**不可能分歧**。

这件事比听上去重要。正确的数字是**逐条** `max(0, inputTokens − cacheReadTokens)` 再累加，因为**单条记录的 `inputTokens` 里已经包含了它的缓存命中** —— 而一个会话的缓存命中合计可能远大于它的输入合计（实测一条真实会话：输入 4.87M，缓存命中 400M）。

**用合计相减而不是逐条相减，会得到 `max(0, 负数) = 0`，估算偏差 15%+。**

前两个版本各错了一次：一版把所有输入按全价计，**高估约 18%**；下一版改成合计相减，**低估**。两次都被抓出来了，现在都有断言守着。

### 为什么用 `ctx.goals.block()`

它是官方文档指定的策略入口，而且**在同一次调用里就解除了续跑**：

```ts
/**
 * Mark an active goal blocked and disarm it.
 * @param reason - policy-owned stable code and human-readable explanation.
 */
block(agent: Agent, ref: GoalRef, reason: GoalBlockReason): GoalView
```

### 用到的机制

| 目的 | 机制 | 为什么选它 |
| --- | --- | --- |
| 读花费 | `session/event` → `assistant/message` | 持久事实；重启后可重放。`agent/assistant-stream` 是呈现数据，不是重放源 |
| 归因到目标 | `agent/inbox/claimed` | 唯一存在的 消息↔turn 链接 |
| 执行 | `ctx.goals.block()` | 官方策略入口；同一次调用里解除续跑 |
| 配置 | `@deepseek-ai/schemastery` 的 `Config` | profile 级默认值；经过校验，不是常量 |
| 会话内控制 | `ctx.commands.register()` | 预算是运行时决策。官方 `/goal` 命令用的同一套机制 |
| 客户端数据 | `sessionProjections.register()` + `wire` 视图 | 从日志 fold，重启/分叉/摘录自动正确；客户端读同一个数 |
| UI 文案 | `ctx.locale.register()` + `bind()` | 官方硬要求：客户端 UI 文案必须走字典 |

---

## 被否掉的方案

**用 `agent/turn-stopping` 拦停失控的 turn。**
**粒度错了**：预算是**目标级**的事实、横跨多轮，而 `turn-stopping` 是轮级钩子、没有跨轮视野。更糟的是在那里阻断会让目标保持 `active`，续跑驱动立刻又开一轮 —— **那是死锁，不是停止**。

**让模型用工具自己管自己。**
框架自己的文档就指出了自我评估的弱点（*"No independent evaluator — the model-facing goal policy decides when evidence is sufficient"*）。**让被约束方执行对自己的约束，恰好在预算耗尽、判断力最差的时候失效** —— 而且它还要在预算已经花完之后再花一次模型调用。

**做第 44 个成本看板。**
生态已经覆盖了，而且看板拦不住任何东西。

**把预算只放在插件配置里。**
第一版就是这么做的，错了：配置在启动时读取，所以改预算要改 YAML + 重启 —— 而那是你当场决定的值。**会话级的预算需要会话级的界面**，这就是 `/budget` 存在的原因，配置只留默认值。

---

## 失败模式

已知的，连同当前的缓解手段和仍未解决的问题。

| # | 怎么坏 | 表现 | 缓解 | 仍未解决 |
| --- | --- | --- | --- | --- |
| 1 | 一轮里混有人类消息和目标消息 | 人类的消费被记到目标上；过早阻断 | 严格过滤 `source.kind === 'goal'` | 混合轮的花费无法干净拆分；发生时记一条警告 |
| 2 | 单价与默认值不同 | 成本估算偏移；阻断点错误 | 所有单价都可配；文档说明这是估算 | 供应商调价、峰谷价、网关加价都不跟踪 |
| 3 | 重启后重建状态 | 预算重置或翻倍 | 花费只从会话日志重算，不另存 | 会话格式迁移可能改变字段可用性 |
| 4 | 适配器不上报 `usage` | 花费**静默**未计入 | 标记为**不可归因**并计数，**从不猜**；阻断信息里报告条数 | **完全不上报 usage 的供应商根本无法约束** |
| 5 | 一个会话里有多个目标 | 花费记到错的目标上 | 按 `goalId` 过滤 | 切换目标时的边界轮次 |
| 6 | 与续跑驱动竞争 | 阻断之后还是开了一轮 | `block()` 在同一次调用里解除续跑；dispose 时清账本 | 已被接受但尚未执行的轮次（驱动 README 里记录的卸载竞争） |
| 7 | 账本注册在一个结构里但没注册在另一个 | **归因静默失效** —— 不报错 | 两个结构一起维护，并有测试断言 | 未知 |
| 8 | INFO 级别下启动日志不可见 | 插件看起来没加载 | 启动可见性用 `console.log`；告警用 `logger.warn` | 详细程度尚不可配 |
| 9 | ~~`/budget` 覆盖是进程内的~~ | ~~重启后回到 profile 默认~~ | **已修**：覆盖活在 `goalBudget` 投影里，从命令服务本来就会写的 `command/run` 事件 fold 出来 —— 是重建的，不是记住的 | — |
| 10 | 目标已被阻断，然后调高预算 | 花费仍超旧限额，但没人重新检查 | 设置或清除预算时会清掉阻断标记，下一步重新判定 | 已经 `blocked` 的目标需要操作者手动恢复 |
| 11 | 客户端与宿主各算一套成本 | 看到的数和阻断的数不一致 | 花费由宿主算好放进投影，**客户端只显示** | 客户端读不到 profile 默认值，所以只有设了会话上限才显示分母 |

**第 7 条是要盯着的那条：它失败时*没有声音*。第 8 条也是。**

两条都是靠**测行为**而不是**检查有没有报错**发现的 —— 和框架自己的 post-mortem 0001 同一个形状：那里 178 个绿灯测试和 100% 行覆盖，与一个完全不能用的功能同时存在。

### 缓存计价

在 90% 缓存命中率下，忽略 `cacheReadTokens` 会把成本**高估 2.7 倍**（实测场景：1000 输入 / 900 命中 / 100 输出）。

这个误差**不是固定倍数** —— 它随命中率增长，而单价差约 50 倍。所以 `cacheReadTokens` 单独计价，并从 `inputTokens` 里扣掉以避免重复计费。

---

## 开发

```sh
npm run typecheck   # tsc
npm test            # 5 个 spec，不需要 API key
npm run build       # esbuild 打包 → lib/index.js
```

**测试套件是用变异检验的，不只是"跑绿"。** 把任何一个计价 bug 放回去、或者去掉 wire 视图需要的 `nullable()`，套件都会变红。

其中两个变异**最初是漏网的** —— 测试从没喂过 `k` 后缀，也从没喂过非零的 `cacheReadTokens`。`test/accounting.spec.ts` 和 `budget-command.spec.ts` 里的后缀用例就是这么来的。

5 个 spec 各管一件事：

| Spec | 管什么 |
| --- | --- |
| `loader.spec.ts` | 导出形状（走真实的 `unwrapExports` 语义）|
| `budget-command.spec.ts` | `/budget` 处理器；**会话覆盖真的改变了阻断阈值**；清除后不再误触发；一个目标不会被阻断两次 |
| `accounting.spec.ts` | 计价与判定；缓存从输入扣掉且不会变负；「谁先到算谁」两个方向 |
| `projection-view.spec.ts` | 投影的 `wire` 视图能通过它自己的 `viewSchema`（**0.4.0 的事故**：非空 schema 让每个没设预算的会话历史加载失败）|
| `client-pill.spec.ts` | 浏览器半边：读对层级、走 portal、点得开、文案走字典 |

### 两件值得单独说的事

**`loader.spec.ts` 驱动真实的加载路径，而不是手工挂载插件。** 因为手工挂载**验证不了插件怎么加载**。它断言没有 `export default` —— 一个 default 导出会让 loader 解析成一个裸的 `apply` 函数，丢掉旁边的 `inject`/`name`/`Config`，于是 fiber 用空的 `inject` 构建，插件在第一次访问服务时崩溃。

**类型声明即依赖清单。** 这个插件用到的 DSH API 类型都在 [`types/dsh-ambient.d.ts`](types/dsh-ambient.d.ts)，**每一条都标了出处文件和行号**。那个文件同时就是完整的依赖面清单，而且零安装成本。

---

## License

MIT
