# Mika MCP 接口速查（0.1.33）

Mika 是跑在安卓手机上的 agent：`com.wangzan101.mika`。它把 MCP 服务开在手机本机
`127.0.0.1:8765/mcp`（Streamable HTTP，Bearer token），用 `adb forward` 给电脑用。
任务在**独立虚拟屏**上执行，用户照常用手机。

## 鉴权与地址

- token / 端口 / boot 号写在手机 `/sdcard/Android/data/com.wangzan101.mika/files/mcp-usb.json`
- `scripts/mika.mjs sync` 会读它、建转发、写到 `~/.mika/config.json`（0600）
- token 每次开关「电脑访问」都会换；手机重启后要重新 `sync`
- **本机端口不要直接用 8765**：很多脚本默认占这个口，`adb forward` 失败时不会报错，只会把请求打到本机服务上（表现为 401/501/HTML）。桥默认 18765。

## 工具

| 工具 | 用途 | 备注 |
|---|---|---|
| `mika_run_task {goal, conversation?}` | 下发任务 | 立刻返回 `task_id`，不等 |
| `mika_task_status {task_id}` | 查状态/提问/结果 | 只读 |
| `mika_wait_task {task_id, timeout_s≤50}` | 等到状态变化 | 循环调用即可 |
| `mika_answer {task_id, text}` | 回答 Mika 的提问 | 不能同意付款/确认类 |
| `mika_steer_task {task_id, text}` | 运行中追加指令 | 排队，不保证立即生效 |
| `mika_cancel_task {task_id}` | 取消 | 别用来「重试」 |
| `mika_list_tasks {limit}` | 最近任务 | 找回 conversation |
| `mika_device_state` / `mika_wake_device` / `mika_unlock_device` | 屏幕与解锁 | 解锁依赖手机上已配置的凭据 |

`conversation` 是上下文句柄：同一活动连续几步都传同一个，Mika 才不会丢页面。

## 状态机

```
running → done
        → waiting_for_answer   （事实性提问，可 answer）
        → waiting_on_phone     （登录/验证码/付款/系统授权，只能人工）
        → failed / cancelled
```

`waiting_on_phone` 时 Mika 会在手机上发通知（动作：我来处理 / 跳过 / 取消任务）。
**不要 cancel 掉重下**，重下会丢上下文，也可能重复已经做过的动作。

## 手机助手

`com.wangzan101.mika:helper`（以 shell 身份运行，负责虚拟屏 + 调试通道）**重启后不自恢复**：

```bash
adb shell sh /sdcard/Android/data/com.wangzan101.mika/files/usb-start.sh
```

`mika_device_state.device.helper_available=false` 就是这个原因。`sync` 会自动补。

## 安全

- token 等同「能操作这台手机」的凭据，配置文件权限 0600，不要进仓库
- Mika 明确不做「通过 MCP 批准付款/确认」；这类步骤一律留在手机上
