# dsh-token-budget · 每日 Token 预算守卫

给 DSH 加一层**每日 token 预算**：到阈值就提醒，额度用完时询问「是否继续运行」，任务失控时直接硬停。

- 账本按天累计，重启不丢；跨天自动归零。
- 三个层次：**提醒**（80%）→ **询问**（100%）→ **硬停**（125%）。
- 工作正在跑的时候，Host 会在工具调用前用 DSH 的审批流再问一次，用户可以选择「继续 / 停止」。
- 常驻胶囊 + 明细面板，可以直接在面板里改上限、看近 7 天。

---

## 三个防线

| 层 | 触发点 | 行为 | 拦不拦得住 agent |
| --- | --- | --- | --- |
| 提醒 | 当日用量 ≥ `warnRatio × dailyLimit` | 页面顶部浮出提示条，可「知道了」 | 不拦，只是提醒 |
| 询问 | 当日用量 ≥ `dailyLimit` | ① 页面中央弹「继续运行 / 今天停止 / 稍后」；② 下一个工具调用前，Host 通过 `tools/pre-execute` 返回 `ask`，审批流里问用户「是否继续运行」 | **拦**：未批准前工具调用不执行 |
| 硬停 | 当日用量 ≥ `hardStopRatio × dailyLimit` | 直接 `deny` 工具调用，返回 `daily-token-budget-hard-stop` | **拦**：连问都不问 |

用户选「继续运行」后进入 `graceMinutes` 分钟的宽限期，期间不再询问；选「今天停止」后当天所有工具调用直接被拒，直到点「重置今日」或跨天。

一个实现上的取舍：`ask` 是**先放行宽限期再问**的（Host 看不到审批结果，而一次任务里往往连着好几个工具调用，逐次弹窗太吵）。所以「稍后 / 拒绝这次审批」不等于停下——今天要彻底停，请点「今天停止」，或者把 `hardStopRatio` 调小让它直接硬停。

## 界面

- **右下角胶囊**：`今日 1.2M / 2.0M` + 百分比 + 状态点（绿 / 橙 / 红）。点一下展开面板。
- **面板**：进度条、输入/输出/缓存读/请求数拆分、近 7 天柱状图、继续/停止/重置按钮、上限与提醒比例输入框。
- **顶部提示条**：达到提醒阈值时出现，「查看」展开面板，「知道了」当天不再提示。
- **中央询问框**：额度用完时出现；文字会说明「当前任务仍在运行」并问「是否继续运行？」。
- 颜色跟随 Harness 主题（用 `Canvas` / `CanvasText` 系统色，透明度用 `rgba(128,128,128,…)`）。

## 配置

| key | 默认 | 说明 |
| --- | --- | --- |
| `dailyLimit` | `2000000` | 每日 token 上限 |
| `warnRatio` | `0.8` | 提醒阈值（占上限比例） |
| `graceMinutes` | `10` | 「继续运行」放行的分钟数 |
| `hardStopRatio` | `1.25` | 超过上限多少倍直接硬停 |

优先级：**面板里保存的值**（落在账本 `meta.overrides`）> **bundle patch 里的 config** > 默认值。

只想给某个 profile 调默认值，就写进该 profile 的 `cordis.patch.yml`（按 id 覆盖这一行；`config` 是整体替换，不是深合并）：

```yaml
- id: dsh-token-budget
  config:
    dailyLimit: 500000
    warnRatio: 0.9
    graceMinutes: 5
    hardStopRatio: 1.25
```

## HTTP 接口

Host 半在 `webServer` 上注册了 6 个同源接口（页面自己用，也可以脚本调用）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-token-budget/status` | 当日快照：用量、比例、宽限期、是否停止、近 7 天 |
| POST | `/dsh-token-budget/config` | 改配置，body `{ dailyLimit?, warnRatio?, graceMinutes?, hardStopRatio? }` |
| POST | `/dsh-token-budget/continue` | 允许继续，body `{ minutes? }`（不传用 `graceMinutes`） |
| POST | `/dsh-token-budget/stop` | 今天停止 |
| POST | `/dsh-token-budget/ack-warn` | 确认提醒，今天不再弹提示条 |
| POST | `/dsh-token-budget/reset` | 把今天用量清零、解除停止和宽限期 |

`GET /dsh-token-budget/status` 返回示例：

```json
{
  "date": "2026-10-27", "limit": 2000000, "warnAt": 1600000,
  "total": 2374, "input": 1871, "output": 503, "cacheRead": 162816,
  "requests": 2, "ratio": 0.001187,
  "warn": false, "over": false, "ackWarn": false, "warned": false,
  "stopped": false, "graceUntil": 0, "graceActive": false,
  "running": 0, "graceMinutes": 10, "warnRatio": 0.8, "hardStopRatio": 1.25,
  "history": [{ "date": "2026-10-27", "total": 2374 }],
  "ledgerPath": "C:\\Users\\<you>\\.dsh\\token-budget\\ledger.json"
}
```

## 账本

位置：`<DSH_HOME>/token-budget/ledger.json`。

```json
{
  "version": 1,
  "days": {
    "2026-10-27": {
      "input": 1871, "output": 503, "cacheRead": 162816,
      "cacheWrite": 0, "reasoning": 0, "requests": 2
    }
  },
  "meta": { "graceUntil": 0, "ackWarnDay": "2026-10-27", "overrides": {} }
}
```

写入是先写临时文件再 `rename` 的原子替换，不会写出半个 JSON；只保留最近 30 天。删掉这个文件等于把预算清零。

## 计量口径

- 数据来源是 Host 的 `session/event` 事件里 `assistant/message.data.usage`，字段直接取 `inputTokens` / `outputTokens` / `cacheReadTokens`。
- **计入总额**：`inputTokens + outputTokens`。
- **不计入总额**：`cacheReadTokens`（缓存命中很便宜，单独展示；如果你更关心"真实花费"，可以用面板里的缓存读数字自己折算）。
- 一条 `assistant/message` 记 1 次请求。
- 落账用事件自带的 `time` 时间戳按**本机时区**切日，0 点后自动写到新的一天。

## 安装

### 装到别的 DSH（从 GitHub）

```powershell
# 1. 把包挂进你的 profile（把 URL 换成实际仓库）
plugin_manager install_bundle  target="github:jingciling/dsh-token-"

# 2. 重启 Harness，让它按 bundle patch 挂载
```

或者手动两步：

```powershell
cd $HOME\.dsh\profiles\<你的 profile>
pnpm add github:jingciling/dsh-token-
```

然后把 `@local/dsh-token-budget` 加进该 profile `package.json` 的 `dsh.profile.bundles` 数组。

### 本机开发（软链安装）

本机安装位置是 `desktop` profile 的插件目录：

```
%USERPROFILE%\.dsh\profiles\<profile>\node_modules\@local\dsh-token-budget  ->  <工作区>\dsh-token-budget
```

- 用 `plugin_manager install_bundle` 以 `link:` 方式挂进 profile，bundle patch 自动插入一行 `dsh-token-budget`。
- Host 半改完**重启 Harness**（或重新 apply 插件）生效。
- Client 半改完刷新页面生效（模块由 Host 按需提供，不需要构建）。

卸载：

```
plugin_manager remove_bundle  @local/dsh-token-budget
```

会让 patch 行的状态变成 `missing`，账本文件保留。

## 开发

```
dsh-token-budget/
├── package.json         # 包名、dsh.bundle / dsh.client 字段、files 白名单
├── cordis.patch.yml     # bundle patch：插入一行 Host 插件（含默认 config）
├── index.js             # Host 半：记账、闸门、HTTP 路由
├── client.js            # Client 半：胶囊、面板、提醒条、询问框
├── locale/{en,zh}.json  # 界面文案（当前界面主要用中文，这里留作扩展）
└── test/gate.test.mjs   # Host 半契约测试
```

```powershell
npm test        # = node test/gate.test.mjs
```

## 测试

Host 半有一组不依赖 Harness 运行时的契约测试（桩化 Cordis context，`DSH_HOME` 指到临时目录）：

```powershell
node test/gate.test.mjs
```

7 个用例覆盖：用量记账与事件过滤、提醒阈值、`ask` + 宽限期、`stop` 拒绝、硬停、`/config` 持久化、账本原子写与重载。

> 用 `node --test test/gate.test.mjs` 也可以，但受限沙箱下 runner 会给每个文件 spawn 子进程（EPERM），直接 `node <file>` 最稳。
> 仓库带了一个 GitHub Actions 工作流（`.github/workflows/ci.yml`），推上去就会在 Node 22 上跑 `npm test`。

## 已知限制

- 只记「事件里报出来的 usage」。某个 provider 不回报 usage 时，那段消耗不会进账本。
- 按时间戳切日：跨 0 点仍在跑的任务，0 点后的消耗记到新的一天，而不是归到开始那天。
- `ask` 依赖 DSH 的审批应答者。headless / 没有应答者的环境里 `ask` 会失败关闭（等价于拒绝），此时用面板或 `/continue` 放行。
- 预算只是「提醒 + 闸门」，不会自动降级模型；要真的省钱，还是得配合调小上限 + 看到提醒就收手。
