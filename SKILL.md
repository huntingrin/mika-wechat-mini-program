---
name: mika-wechat-mini-program
description: >
  用 Mika（安卓手机上的 AI agent，MCP over USB）或 iPhone 镜像（phone-harness，截图 + OCR + 坐标）
  操作微信，跑通「公众号发关键词 → 点小程序卡片 → 活动页动作」这类任务：抽奖、领券、签到、答题、查券包。
  含通道自检（adb / Mika / iPhone 镜像）、任务下发与等待、页面证据核验、不可逆动作前的闸门，
  以及必须交还给用户的手机步骤。
  Use when the user wants to drive WeChat / 公众号 / 微信小程序 on an Android phone or an iPhone
  through Mika or iPhone Mirroring, run a 抽奖 / 领券 / 签到 flow, or says 用 Mika 点微信 /
  手机跑一遍这个活动 / 连手机帮我点 / 用 iPhone 镜像操作手机.
metadata:
  version: "0.1.0"
  platforms: darwin, linux
---

# mika-wechat-mini-program

把「在手机上点一遍微信活动」变成可复现的命令：Mika 负责操作，你负责拆步骤、设闸门、核验结果。

**本文件所在目录就是 `$SKILL`。** 命令里的 `$SKILL` 换成它的绝对路径。

## 什么时候用

| 用 | 不用 |
|---|---|
| 公众号关键词领券、抽奖、签到 | 需要付款、绑卡、改密码 |
| 小程序活动页里的可逆操作 | 批量多账号、刷单、绕过验证码 |
| 查券包、查中奖记录、读活动规则 | 微信登录、短信验证码（只能人工） |

## 铁律

1. **Mika 说「完成了」不算完成。** 必须有页面原文：标题、按钮文案、结果弹窗、记录条目。
2. **不可逆动作前必须停。** 抽奖、领券、核销、下单、发送消息给他人 —— 先回报证据，等用户点头。
3. **登录、验证码、付款、系统授权永远交还用户。** Mika 会停在 `waiting_on_phone`，这不是故障。
4. **一次只跑一个活动。** 不并发下发任务，Mika 的虚拟屏只有一个。
5. **账号先核实。** 公众号看主体名 + 认证标；小程序看是不是同一个品牌，别被同名号骗。
6. **不代答风险问题。** `mika_answer` 只回答「选哪个按钮」这类事实问题，不替用户同意条款。

## 第 0 步：通道自检（每次都跑）

```bash
node "$SKILL/scripts/mika.mjs" bootstrap    # 一次性判断：adb / 设备 / Mika
```

按输出的 `path` 分三条路：

| path | 含义 | 下一步 |
|---|---|---|
| `mika` | adb、设备、Mika 都在 | `sync` → `state`，走 Mika MCP（首选） |
| `ios` | 没有安卓设备，但 iPhone 镜像在线 | 用 `scripts/ios_bridge.py`（截图 + OCR + 坐标） |
| `adb-fallback` | 设备在，但没装 Mika | 换 `android-device-operator` 技能，用 adb 直接操作（能力降级） |
| `blocked` | 没 adb 也没镜像，或没设备 | 按 `next` 提示装工具链、开 USB 调试 |

```bash
node "$SKILL/scripts/mika.mjs" bootstrap --install   # adb / 兜底技能缺失时补齐整套工具链
node "$SKILL/scripts/mika.mjs" sync                  # 取 token、建转发、检查解锁与手机助手
node "$SKILL/scripts/mika.mjs" state                 # 看 ready / helper_available / 锁屏
```

`--install` 装的是**整套 `android-device-operator`**（克隆技能目录 + 跑它自己的 `preflight`），
不是孤零零一个 adb —— 只装 adb 时 `preflight` 仍然跑不起来。

`ready=true` 且 `helper_available=true` 才能继续。

### 没装 Mika 时的兜底

不代装 Mika、不静默降级。用 `android-device-operator`
（<https://github.com/marswaveai/cola-skills/tree/main/android-device-operator>）。

它是一整套工具：技能目录 + `scripts/cli.mjs` + `preflight` 自检，依赖 **adb 和 Node ≥ 22**。
装法就一条：`node script/mika.mjs bootstrap --install`；手动则是

```sh
git clone --depth 1 https://github.com/marswaveai/cola-skills.git
cp -R cola-skills/android-device-operator ~/.agents/skills/
```

装好后先跑它自己的自检，再看通道：

```bash
node ~/.agents/skills/android-device-operator/scripts/cli.mjs preflight
node ~/.agents/skills/android-device-operator/scripts/cli.mjs snapshot --url <页面片段>
node ~/.agents/skills/android-device-operator/scripts/cli.mjs act --op click --ref 'ax:12' --expect-text '…'
```

这条路的硬限制（照抄，别承诺做不到的事）：

- 微信小程序**不走 CDP**，只能走 `device` 通道：无障碍树 + 坐标，可读性差
- 纯 adb 输不了中文（`NonAsciiInput`），关键词得让用户手打
- 小程序 WebView 常只暴露一个容器节点，读不到按钮文字 → 只能截图定位，稳定性不足以固化成流程
- 遇到 `GateClosed`（微信调试开关）必须人手开一次

所以：**有 Mika 走 Mika；没有 Mika 只做「可读 + 单次点击」，不承诺跑通整条活动链。**

### iOS 通道（iPhone 镜像）

```bash
PY="$(uv tool dir)/phone-harness/bin/python"
$PY scripts/ios_bridge.py state            # ok=false 会说明卡在哪
$PY scripts/ios_bridge.py text             # OCR 出来的页面文本
$PY scripts/ios_bridge.py shot /tmp/a.png  # 截图，用来量坐标
$PY scripts/ios_bridge.py longtap 我的 --duration 0.3
```

三条必须记住的：

1. **坐标按截图算，不按 OCR**：OCR 的 y 常年偏 30–60pt，且窗口尺寸会变。
2. **小程序里要按住**：tab 0.2–0.35s，普通按钮 0.45–0.9s；短点会被静默丢弃。
3. **中文先 `pbcopy` 再 ⌘V**：`type_text` 会粘成乱码。

硬限制：小程序「账户登录」页**不接收任何合成点击**（勾选、一键登录、手机号登录都点不动），
必须让用户解锁手机登录一次；真机一被使用，镜像立即断开。详见 `references/ios-mirroring.md`。

### 三个已知坑

| 现象 | 原因 | 处置 |
|---|---|---|
| 401 / 501 / HTML 乱码 | 本机 8765 被别的服务占了，`adb forward` 静默失败 | 桥默认用 18765；冲突就 `MIKA_LOCAL_PORT=xxxxx` |
| `helper_available=false` | 手机重启后助手不自恢复 | `sync` 会自动补跑 `usb-start.sh`，仍不行就在手机上打开 Mika 一次 |
| `waiting_on_phone` 卡住 | 登录墙 / 验证码 / 付款 / 权限弹窗 | 让用户点 Mika 通知「我来处理」，不要 cancel 重来 |

## 第 1 步：把活动拆成三段

任何「点一遍」都拆成：

```
到达（可逆） → 判断（读证据） → 不可逆动作（闸门后执行）
```

例：`进公众号发关键词 → 进活动页 → [闸门] → 抽奖 → 读中奖记录`

拆不出来就说明还没读懂活动，先读规则页，别下发任务。

## 第 2 步：下发任务（goal 五段式）

Mika 接的是自然语言，写清五件事，成功率差一个量级：

```
打开<App>。<身份核验：搜什么、确认哪个主体>。<具体动作 1、2、3>。
停在<停点>之前，不要<禁止项>。完成后告诉我：<要引用的页面原文>。
```

实测可用模板见 `flows/luckin-lidong-first-cup.json`。

两个要点：

- **停点要写成「按钮前面」**，不是「进入页面」。Mika 会自己判断页面到没到。
- **禁止项要列全**：不点抽奖、不领券、不下单、不付款、不分享。少写一条就可能多走一步。

## 第 2.5 步：让 Mika 自己持有技能（推荐）

长剧本不要每次塞进 `goal`。更好的做法是**把流程写进 Mika 的「记忆与技能」**，
之后只下短指令，由 Mika 自己套用 —— 本机脚本只当调度器。

```bash
# 一次：让 Mika 把剧本存成技能（它自己写，自己存）
node "$SKILL/scripts/mika.mjs" do "不要操作手机，把我们这套流程存成你的技能，内容如下：……"

# 之后：短指令，Mika 会用它的技能
node "$SKILL/scripts/mika.mjs" do "用你的瑞幸抽奖技能，去中奖记录看那张 8.3 折券还在不在，停在去喝一杯之前"
```

现成剧本见 `mika-skill/luckin-lottery.md`（Mika 技能格式：frontmatter + 入口 / 步骤 / 容易出错 / 怎样算办成 / 什么时候停下）。

两个实测结论：

- Mika 的技能卡片会标「试用中」，要**完整跑成一单**才转正式；只查券不算。
- **Mika 会自己点隐私弹窗的「同意」**。不想让它代答，就在 goal 里明确写「隐私或授权弹窗停下交给我」。

## 第 3 步：等待与状态

```bash
node "$SKILL/scripts/mika.mjs" do "<goal>"          # 下发并等到结束
node "$SKILL/scripts/mika.mjs" status <task_id>     # 随时查
node "$SKILL/scripts/mika.mjs" steer <task_id> "别点抽奖，先停下"
node "$SKILL/scripts/mika.mjs" answer <task_id> "选左边的按钮"
```

| 状态 | 含义 | 处理 |
|---|---|---|
| `done` | 任务结束 | 读内容，做证据核验 |
| `waiting_on_phone` | 需要人在手机上操作 | 通知用户，保持任务别 cancel |
| `waiting_for_answer` | Mika 在问事实问题 | `answer`，别替用户做决定 |
| `failed` / `cancelled` | 失败/取消 | 看 note，按第 6 节 |

## 第 4 步：证据核验（不可跳过）

`done` 之后逐条比对：

| 核验项 | 通过标准 |
|---|---|
| 账号 | 主体名 + 认证标，与目标一致 |
| 到达 | 页面标题、活动名，与你预期一致 |
| 前置状态 | 中奖记录为空 / 按钮可点 / 次数未用 |
| 执行后 | 按钮变灰或文案变化，记录里新增条目 |
| 结果原文 | 券名、折扣、有效期、适用范围，逐条抄自页面 |

**任一格没有页面原文支撑，就当没发生**，让 Mika 回读一次。

## 第 5 步：闸门

`flows/*.json` 里带 `"gate": true` 的步骤会在执行前停下，退出码 3。确认后：

```bash
node "$SKILL/scripts/mika.mjs" flow flows/luckin-lidong-first-cup.json --from draw
```

必须设闸门的动作：抽奖、领券、核销、下单、发消息给他人、授权登录、同意条款。

## 第 6 步：失败处置

| 现象 | 处置 |
|---|---|
| 卡在登录页 | 交还用户；登录后从断点 `--from` 继续 |
| 提示「活动已参与」「已抢完」 | 记录实际文案，别重试；这类状态重试无用 |
| 找不到公众号 | 让 Mika 报告搜索结果列表，人工确认主体后再选，不要猜第一个 |
| 小程序打不开 | 让 Mika 回读卡片形态（文字链 / 卡片 / 二维码）；二维码只能人工扫 |
| 结果与规则不一致 | 以页面原文为准，把差异记进规则卡 |

## 交付

给用户三样东西：**结果原文**（券名/折扣/有效期/适用）、**当前状态**（还能不能再用一次）、**下一步建议**（别点「去使用」除非用户要下单）。

## 参考

| 文件 | 内容 |
|---|---|
| `references/android-bootstrap.md` | 电脑接手机：adb 安装/探测、设备状态、没装 Mika 时怎么兜底 |
| `references/ios-mirroring.md` | iPhone 镜像通道：已验证路径、按压时长、坐标校准、登录页硬限制 |
| `references/mika-mcp.md` | MCP 工具清单、状态机、token 与端口细节 |
| `references/wechat-miniprogram.md` | 公众号主体核验、卡片形态、登录墙、次数判断 |
| `references/verified-run-2026-11-03.md` | 瑞幸「立冬第一杯」实测记录（含真实 task_id 与页面原文） |
| `mika-skill/luckin-lottery.md` | 写进 Mika「记忆与技能」的剧本（Mika 自己持有并套用） |
| `flows/luckin-lidong-first-cup.json` | 本机编排版流程定义（备用，逐步下发） |
