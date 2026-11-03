# mika-wechat-mini-program

在手机上跑微信小程序活动的 Agent Skill：**公众号发关键词 → 点小程序卡片 → 活动页动作**（抽奖、领券、签到、答题、查券包）。

三条通道，按环境自动选：

| 通道 | 条件 | 能力 |
|---|---|---|
| **Mika（安卓）** | 装了 Mika（`com.wangzan101.mika`） | MCP over USB，元素级操作，可跑整条流程 |
| **adb 兜底（安卓）** | 没装 Mika，有 adb | 走 [android-device-operator](https://github.com/marswaveai/cola-skills/tree/main/android-device-operator)，无障碍树 + 坐标 |
| **iOS 镜像** | 没有安卓设备，Mac 上有 iPhone 镜像 | 截图 + OCR + 坐标，能导航能读页，登录页要人工 |

## 为什么值得做成 Skill

这类任务真正的风险不是「点不到」，而是**点过头**：抽奖一天一次、领券不可撤销、0 元券不等于免配送费。
所以 skill 的核心不是自动化，是**闸门**：

- 到达页（可逆）可以反复跑
- 抽奖 / 领券 / 下单前必须停，先回报页面证据（活动名、账号主体、中奖记录是否为空）
- 登录、验证码、付款永远交还用户

## 安装

```sh
git clone https://github.com/huntingrin/mika-wechat-mini-program.git
cp -R mika-wechat-mini-program ~/.agents/skills/
```

## 用法

```bash
# 0. 通道自检：adb / 设备 / Mika / iPhone 镜像，四选一
node scripts/mika.mjs bootstrap
node scripts/mika.mjs bootstrap --install     # 缺工具链时补齐（含 android-device-operator）

# 1. Mika 通道
node scripts/mika.mjs sync
node scripts/mika.mjs do "打开微信，进瑞幸小程序，停在抽奖按钮前，别点"

# 2. iOS 通道
PY="$(uv tool dir)/phone-harness/bin/python"
$PY scripts/ios_bridge.py state
$PY scripts/ios_bridge.py longtap 我的 --duration 0.3
```

流程文件也可以逐步跑，遇到闸门自动停（退出码 3）：

```bash
node scripts/mika.mjs flow flows/luckin-lidong-first-cup.json
```

## 实测记录

2026-11-03 在 Pixel 6 Pro（Mika）和 iPhone 15 Pro Max（镜像）上跑瑞幸「立冬第一杯」：

- 安卓：公众号 → 小程序卡片 → 抽奖 → 中 8.3 折券，全程 4 分钟，抽奖前人工确认
- iOS：微信 → 搜索 → 小程序 → 我的 → 我的优惠券，停在「去使用」前

细节见 `references/verified-run-2026-11-03.md`。

## 目录

```
SKILL.md                     技能正文：铁律、流程、闸门、失败处置
scripts/mika.mjs             Mika MCP 桥 + bootstrap + flow 执行器
scripts/ios_bridge.py        iPhone 镜像通道（截图 / OCR / 点击）
flows/                       可执行的流程定义（带闸门）
mika-skill/                  写进 Mika「记忆与技能」的剧本
references/                  通道细节、微信侧要点、实测记录
```

## 边界

- 不做批量、多账号、注入/改包、绕过验证码
- 不代付款、不代同意条款、不代登录
- 微信小程序在 iOS 镜像里没有 AX/CDP，只能 OCR + 坐标；小程序登录页不接收合成点击
- Mika 是第三方 App，装不装由用户决定；`bootstrap` 不会自动安装它

## 许可

未附许可证，保留所有权利。需要使用请开 issue。
