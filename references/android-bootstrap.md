# 电脑端接入手机：工具链 → 通道 → 兜底

一条命令判完：

```bash
node "$SKILL/scripts/mika.mjs" bootstrap [--install] [--json]
```

退出码：`0` 能干活（mika 或 adb-fallback），`2` 卡住（blocked）。

## 判定树

```
adb 在不在？
├─ 不在 → --install 装的是「整套 android-device-operator」（技能 + 依赖 + preflight），不是单独装 adb
│         装不上 → blocked，打印 preflight 给出的修复命令
└─ 在 → 有 device 状态的设备吗？
   ├─ 无 / unauthorized / offline → blocked，给手机侧动作
   └─ 有 → 装了 Mika 吗？
      ├─ 装了 → path=mika（MCP over USB，首选）
      └─ 没装 → path=adb-fallback：确认 android-device-operator 在位、Node ≥ 22、跑它的 preflight
```

输出结构（`--json`）：

```json
{
  "adb":    { "installed": true, "path": ".../platform-tools/adb", "version": "..." },
  "device": { "connected": true, "serial": "...", "model": "Pixel 6 Pro", "android": "16" },
  "mika":   { "installed": true, "version": "0.1.33" },
  "fallback": {
    "skill": "/Users/…/.agents/skills/android-device-operator",
    "node": "22.14.0", "node_ok": true,
    "preflight": { "ok": true, "channels": ["device"], "next": ["…"] }
  },
  "path": "mika",
  "next": ["…给人看的下一步…"]
}
```

## 装的是「技能」，不是「adb」

`android-device-operator` 定义了一整套东西：技能目录、`scripts/cli.mjs`、`preflight` 自检、
通道降级逻辑，以及对 **adb** 和 **Node ≥ 22** 的要求。只装 adb 等于只装了一半，`preflight` 照样跑不起来。

`bootstrap --install` 的动作顺序：

1. `git clone --depth 1 https://github.com/marswaveai/cola-skills.git` → `~/.agents/skills/_repos/cola-skills`
2. 复制 `cola-skills/android-device-operator` → `~/.agents/skills/android-device-operator`
3. 跑该技能的 `node scripts/cli.mjs preflight`，用它自己报的 `checks` / `next` 决定还缺什么
4. 只有 `preflight` 明确指向 adb 缺失时，才按它的安装说明补：macOS `brew install --cask android-platform-tools`，
   Windows `winget install --id Google.PlatformTools -e`

手动装同一条路：

```sh
git clone --depth 1 https://github.com/marswaveai/cola-skills.git
cp -R cola-skills/android-device-operator ~/.agents/skills/
node ~/.agents/skills/android-device-operator/scripts/cli.mjs preflight
```

## adb 探测顺序

`PATH` → `$ANDROID_HOME/platform-tools/adb` → `~/Library/Android/sdk` → `~/Android/Sdk` →
`/opt/homebrew/bin` → `/usr/local/bin`。已经装过 Android SDK 的机器不用配 PATH。

## 连手机（用户侧动作）

1. 数据线连电脑（要能传数据，不能是纯充电线）
2. 开发者选项 → 打开「USB 调试」
3. 手机弹「允许 USB 调试吗」→ 允许（建议勾「一律允许」）
4. 无线也行：`adb pair <ip:port>` 输配对码 → `adb connect <ip:port>`

| `adb devices` 状态 | 含义 |
|---|---|
| `device` | 正常 |
| `unauthorized` | 手机上没点允许，或点过但没勾「一律允许」 |
| `offline` | 连接坏了：拔插线，或 `adb kill-server && adb start-server` |
| 列表为空 | 线 / 驱动 / 调试开关，三选一没弄好 |

## 走兜底时怎么用

```bash
SKILL_ADB=~/.agents/skills/android-device-operator
node $SKILL_ADB/scripts/cli.mjs preflight     # 先看 channels 有几条能用
node $SKILL_ADB/scripts/cli.mjs snapshot      # 读页面（text 优先，别截图猜）
node $SKILL_ADB/scripts/cli.mjs act --op click --ref 'ax:12' --expect-text '…'
```

- 它的 `preflight` 报告五环：adb / 设备 / 唤醒 / 调试 socket / 可调试页面，缺哪环给哪环的修复命令
- 微信小程序只有 `device` 通道（无障碍树 + 坐标），没有 `webview`
- 每个动作必须带 `--expect-text`，否则只算「投递成功」，不算生效
- 纯 adb 输不了中文（`NonAsciiInput`），关键词让用户自己打

## 为什么不让脚本自动装 Mika

Mika 是手机上带无障碍权限的 agent，装它等于把一台手机的控制权交给一个 App。
这一步必须是用户自己的决定：`bootstrap` 只报 `path=adb-fallback`，不下载、不安装、不跳转。
