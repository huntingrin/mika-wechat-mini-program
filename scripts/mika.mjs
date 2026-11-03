#!/usr/bin/env node
// mika.mjs — 通过 USB 上的 MCP 驱动 Mika（安卓手机上的 AI agent）
// 只依赖 Node 18+（内置 fetch），不需要任何 npm 包。

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG_DIR = process.env.MIKA_CONFIG_DIR || join(homedir(), '.mika');
const CFG_FILE = join(CFG_DIR, 'config.json');
const PHONE_INFO = '/sdcard/Android/data/com.wangzan101.mika/files/mcp-usb.json';
const USB_START = '/sdcard/Android/data/com.wangzan101.mika/files/usb-start.sh';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// adb 的位置不固定：PATH / ANDROID_HOME / 常见安装路径都有可能
let ADB_BIN = 'adb';

function which(cmd) {
  try {
    return execFileSync('/usr/bin/which', [cmd], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function findAdb() {
  const env = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const candidates = [
    which('adb'),
    env ? join(env, 'platform-tools', 'adb') : null,
    join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'), // macOS 默认 SDK
    join(homedir(), 'Android', 'Sdk', 'platform-tools', 'adb'),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

function adb(args, opts = {}) {
  return execFileSync(ADB_BIN, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function adbOk(args) {
  try {
    return adb(args);
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

function installAdb() {
  // 按 android-device-operator 的安装说明：macOS 用 cask 版 platform-tools
  const platform = process.platform;
  if (platform === 'darwin' && which('brew')) {
    console.log('… 没找到 adb，按技能说明装 platform-tools（brew cask）');
    try {
      execFileSync('brew', ['install', '--cask', 'android-platform-tools'], { stdio: 'inherit' });
      return true;
    } catch {
      return false;
    }
  }
  if (platform === 'win32' && which('winget')) {
    console.log('… 没找到 adb，用 winget 装 Google.PlatformTools');
    try {
      execFileSync('winget', ['install', '--id', 'Google.PlatformTools', '-e', '--accept-package-agreements', '--accept-source-agreements'], { stdio: 'inherit' });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function findFallbackSkill() {
  const cands = [
    process.env.ANDROID_DEVICE_OPERATOR,
    join(homedir(), '.agents', 'skills', 'android-device-operator'),
    join(homedir(), '.agents', 'skills', '_repos', 'cola-skills', 'android-device-operator'),
  ].filter(Boolean);
  return cands.find((p) => existsSync(join(p, 'SKILL.md')) && existsSync(join(p, 'scripts', 'cli.mjs'))) || null;
}

// 兜底通道不是「装个 adb」，是整套 android-device-operator：技能目录 + 它定义的依赖 + 它自己的 preflight
function ensureFallbackSkill(install) {
  const found = findFallbackSkill();
  if (found) return found;
  if (!install) return null;
  const repo = join(homedir(), '.agents', 'skills', '_repos', 'cola-skills');
  const dest = join(homedir(), '.agents', 'skills', 'android-device-operator');
  if (!existsSync(join(repo, 'android-device-operator'))) {
    console.log('… 安装 android-device-operator：克隆 marswaveai/cola-skills');
    mkdirSync(dirname(repo), { recursive: true });
    execFileSync('git', ['clone', '--depth', '1', 'https://github.com/marswaveai/cola-skills.git', repo], { stdio: 'inherit' });
  }
  cpSync(join(repo, 'android-device-operator'), dest, { recursive: true });
  return findFallbackSkill();
}

function fallbackPreflight(dir) {
  try {
    const out = execFileSync(process.execPath, [join(dir, 'scripts', 'cli.mjs'), 'preflight'], {
      encoding: 'utf8',
      timeout: 90000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out);
  } catch (e) {
    const s = `${e.stdout || ''}${e.stderr || ''}`.trim();
    try {
      return JSON.parse(s);
    } catch {
      return { ok: false, next: [s.slice(0, 300) || 'preflight 跑不起来'] };
    }
  }
}

function loadConfig() {
  if (!existsSync(CFG_FILE)) fail('还没同步配置，先跑：node script/mika.mjs sync');
  return JSON.parse(readFileSync(CFG_FILE, 'utf8'));
}

function saveConfig(cfg) {
  mkdirSync(CFG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));
  chmodSync(CFG_FILE, 0o600);
}

function fail(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

// ---------- MCP over Streamable HTTP ----------

let reqId = 0;

async function rpc(cfg, method, params = {}) {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(cfg.sessionId ? { 'Mcp-Session-Id': cfg.sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++reqId, method, params }),
    signal: AbortSignal.timeout(cfg.timeoutMs || 70000),
  });

  const sid = res.headers.get('mcp-session-id');
  if (sid && sid !== cfg.sessionId) {
    cfg.sessionId = sid;
    saveConfig(cfg);
  }

  if (res.status === 401) fail('token 失效了（可能手机重启过）。先跑 sync 重新拿 token');
  if (!res.ok) fail(`MCP HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const ct = res.headers.get('content-type') || '';
  const body = await res.text();

  let msg;
  if (ct.includes('text/event-stream')) {
    const line = body.split('\n').reverse().find((l) => l.startsWith('data:'));
    if (!line) fail(`SSE 里没有 data：${body.slice(0, 200)}`);
    msg = JSON.parse(line.slice(5).trim());
  } else {
    msg = JSON.parse(body);
  }
  if (msg.error) fail(`MCP 错误 ${msg.error.code}: ${msg.error.message}`);
  return msg.result;
}

function unwrap(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((c) => c.type === 'text')?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function call(cfg, name, args = {}) {
  const r = await rpc(cfg, 'tools/call', { name, arguments: args });
  if (r?.isError) fail(`${name} 失败：${JSON.stringify(unwrap(r)).slice(0, 500)}`);
  return unwrap(r);
}

// ---------- commands ----------

function detectDevices() {
  const out = adbOk(['devices', '-l']);
  const rows = out
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/))
    .filter((p) => p[0] && p[0] !== '*')
    .map((p) => ({ serial: p[0], state: p[1] || '', extra: p.slice(2).join(' ') }));
  return {
    all: rows,
    ready: rows.find((d) => d.state === 'device') || null,
    unauthorized: rows.find((d) => d.state === 'unauthorized') || null,
    offline: rows.find((d) => d.state === 'offline') || null,
  };
}

function detectIos() {
  if (process.platform !== 'darwin') return null;
  let mirroring = false;
  try {
    // 进程名是 "iPhone Mirroring"，bundle id 才是 com.apple.ScreenContinuity
    mirroring = !!(execFileSync('pgrep', ['-f', 'iPhone Mirroring'], { encoding: 'utf8' }) || '').trim();
  } catch {
    mirroring = false;
  }
  const harness =
    [which('phone-harness'), join(homedir(), '.local', 'bin', 'phone-harness')].filter(Boolean).find((p) => existsSync(p)) || null;
  return { mirroring, harness };
}

// 第 0 步：这台电脑能不能干这活，走哪条路
function bootstrap({ install = false, json = false } = {}) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const out = {
    adb: { installed: false, path: null, version: null },
    device: { connected: false, serial: null, model: null, android: null },
    mika: { installed: false, version: null },
    fallback: { skill: null, node: process.versions.node, node_ok: nodeMajor >= 22, preflight: null },
    ios: null,
    path: 'blocked',
    next: [],
  };

  let adbPath = findAdb();

  // adb 不在：先补整套 android-device-operator（技能 + 依赖 + 它自己的 preflight），不是只装 adb
  if (!adbPath) {
    out.fallback.skill = ensureFallbackSkill(install);
    if (install && installAdb()) adbPath = findAdb();
    if (out.fallback.skill) out.fallback.preflight = fallbackPreflight(out.fallback.skill);
    if (!adbPath) {
      out.next = [
        ...(out.fallback.preflight?.next || []).slice(0, 3),
        '或直接装整套：node script/mika.mjs bootstrap --install',
      ];
      if (json) console.log(JSON.stringify(out, null, 2));
      else {
        console.log('✗ 没有 adb');
        out.next.forEach((s) => console.log(`  · ${s}`));
      }
      return out;
    }
  }

  ADB_BIN = adbPath;
  out.adb = { installed: true, path: adbPath, version: (adbOk(['version']).split('\n')[0] || '').trim() };

  const dev = detectDevices();
  if (!dev.ready) {
    const ios = detectIos();
    out.ios = ios;
    if (ios?.mirroring) {
      out.path = 'ios';
      out.next = [
        ios.harness
          ? 'iPhone 镜像在跑：用 ios_bridge 读屏/点击（Python：$(uv tool dir)/phone-harness/bin/python）'
          : 'iPhone 镜像在跑，但没有 phone-harness：`uv tool install phone-harness`',
        'PY="$(uv tool dir)/phone-harness/bin/python"; $PY script/ios_bridge.py state',
      ];
      if (json) console.log(JSON.stringify(out, null, 2));
      else {
        console.log('· 没有安卓设备，但 iPhone 镜像在线');
        console.log('→ 通道：iOS 镜像（截图 + OCR + 坐标，没有 AX/CDP）');
        out.next.forEach((s) => console.log(`  · ${s}`));
      }
      return out;
    }
    if (dev.unauthorized) {
      out.next = ['手机上弹出「允许 USB 调试」时点允许（勾选「一律允许」），然后重跑 bootstrap'];
    } else if (dev.offline) {
      out.next = ['设备处于 offline：拔插数据线，或 `adb kill-server && adb start-server`'];
    } else {
      out.next = [
        '手机没连上：插数据线 → 开发者选项打开「USB 调试」→ 手机弹窗点「允许」',
        '无线调试也可：`adb pair <ip:port>` 后 `adb connect <ip:port>`',
      ];
    }
    if (json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log('✗ 没有可用设备');
      out.next.forEach((s) => console.log(`  · ${s}`));
    }
    return out;
  }

  const d = dev.ready;
  const pick = (prop) => (adbOk(['-s', d.serial, 'shell', 'getprop', prop]) || '').trim();
  out.device = { connected: true, serial: d.serial, model: pick('ro.product.model'), android: pick('ro.build.version.release') };

  const pkgs = adbOk(['-s', d.serial, 'shell', 'pm', 'list', 'packages', 'com.wangzan101.mika']);
  out.mika.installed = /package:com\.wangzan101\.mika\b/.test(pkgs);
  if (out.mika.installed) {
    const v = adbOk(['-s', d.serial, 'shell', 'dumpsys package com.wangzan101.mika | grep versionName']);
    out.mika.version = (v.match(/versionName=(\S+)/) || [])[1] || null;
  }

  if (out.mika.installed) {
    out.path = 'mika';
    out.next = ['Mika 已装：跑 `node script/mika.mjs sync` 打通 MCP，然后直接下发任务'];
  } else {
    out.path = 'adb-fallback';
    out.fallback.skill = ensureFallbackSkill(install);
    if (!out.fallback.skill) {
      out.next = [
        'Mika 没装，兜底技能也没有：装整套 android-device-operator',
        'git clone --depth 1 https://github.com/marswaveai/cola-skills.git && cp -R cola-skills/android-device-operator ~/.agents/skills/',
        '或跑：node script/mika.mjs bootstrap --install',
      ];
    } else {
      out.fallback.preflight = fallbackPreflight(out.fallback.skill);
      out.next = ['Mika 没装：转 android-device-operator（adb + 无障碍树/坐标，能力降级）'];
      if (!out.fallback.node_ok) out.next.push(`该技能要求 Node >= 22，当前 ${out.fallback.node}，先升级 Node 再跑`);
      (out.fallback.preflight?.next || []).slice(0, 3).forEach((s) => out.next.push(s));
    }
  }

  if (json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`✓ adb：${out.adb.version}（${out.adb.path}）`);
    console.log(`✓ 设备：${out.device.model || '?'} / Android ${out.device.android || '?'} / ${out.device.serial}`);
    console.log(`${out.mika.installed ? '✓' : '·'} Mika：${out.mika.installed ? out.mika.version || '已安装' : '未安装'}`);
    if (out.path === 'mika') {
      console.log('→ 通道：Mika MCP');
    } else {
      console.log(`→ 通道：adb 兜底（android-device-operator${out.fallback.preflight?.ok ? '，preflight 通过' : ''}）`);
      if (out.fallback.preflight?.channels) console.log(`  可用通道：${out.fallback.preflight.channels.join(' / ')}`);
    }
    out.next.forEach((s) => console.log(`  · ${s}`));
  }
  return out;
}

async function sync(cfg) {
  let devices;
  try {
    devices = adb(['devices']).split('\n').slice(1).filter((l) => l.endsWith('device'));
  } catch {
    fail('adb 不可用：确认已装 platform-tools，并且手机已插线');
  }
  if (!devices.length) fail('没有在线设备：解锁手机 → 允许 USB 调试 → 再跑一次');
  console.log(`✓ 设备：${devices[0].split('\t')[0]}`);

  // 1. 拿 token
  let info;
  for (let i = 0; i < 2; i++) {
    try {
      info = JSON.parse(adb(['shell', 'cat', PHONE_INFO]));
      break;
    } catch {
      if (i === 0) {
        console.log('… 还没开「电脑访问」，尝试启动');
        adb(['shell', 'sh', USB_START]);
        await sleep(2500);
      }
    }
  }
  if (!info?.token) fail('拿不到 token：打开 Mika → 设置 → 电脑访问（MCP），确认 USB 已开启');

  // 2. 端口转发：本机端口单独选，避免撞上本机已有的 8765（很多脚本默认占这个口）
  const port = info.port || 8765;
  const localPort = Number(process.env.MIKA_LOCAL_PORT || cfg.localPort || 18765);
  try {
    adb(['forward', `tcp:${localPort}`, `tcp:${port}`]);
  } catch (e) {
    fail(`端口转发失败（本机 ${localPort} 被占用？用 MIKA_LOCAL_PORT=其他端口 再试）：${e.message}`);
  }
  const alive = adb(['forward', '--list']);
  if (!alive.includes(`tcp:${localPort}`)) fail(`端口转发没生效，本机 ${localPort} 可能被占用`);

  const next = {
    ...cfg,
    url: `http://127.0.0.1:${localPort}/mcp`,
    token: info.token,
    port,
    localPort,
    sessionId: undefined,
  };
  saveConfig(next);
  console.log(`✓ 端口转发 127.0.0.1:${localPort} → 手机:${port}`);

  // 3. 握手 + 检查手机操作通道
  await rpc(next, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'luban-mika-bridge', version: '0.1.0' },
  });
  const state = await call(next, 'mika_device_state');
  const dev = state.device || {};
  console.log(`✓ 已连接（boot ${info.boot ?? '?'}）`);
  console.log(`  解锁=${dev.user_unlocked} 锁屏=${dev.keyguard_showing} 可用=${dev.ready}`);
  if (!dev.helper_available) {
    console.log('… 手机助手没运行，正在启动');
    adb(['shell', 'sh', USB_START]);
    await sleep(3000);
    const again = await call(next, 'mika_device_state');
    console.log(`  手机助手=${again.device?.helper_available ? '已就绪' : '仍未就绪（打开 Mika 输一次密码）'}`);
  }
  return next;
}

async function waitTask(cfg, id, { timeout = 50, quiet = false } = {}) {
  const started = Date.now();
  for (;;) {
    const s = await call(cfg, 'mika_wait_task', { task_id: id, timeout_s: timeout });
    const status = s.status || 'unknown';
    if (!quiet && s.note) console.log(`[${status}] ${s.note}`);
    if (status === 'waiting_for_answer') {
      if (!quiet) console.log(`\n？Mika 在问：${s.question}`);
      return s;
    }
    if (['done', 'failed', 'cancelled', 'error'].includes(status)) return s;
    if (Date.now() - started > (cfg.maxMs || 20 * 60 * 1000)) return { ...s, status: 'timeout' };
  }
}

function printResult(s) {
  const status = s.status || 'unknown';
  const icon = { done: '✓', failed: '✗', cancelled: '⏹', waiting_for_answer: '？', timeout: '⏱' }[status] || '·';
  console.log(`\n${icon} ${status}`);
  const body = s.answer || s.result || s.final || s.text || s.note || '';
  if (body) console.log(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  if (s.conversation) console.log(`\nconversation: ${s.conversation}`);
}

async function main() {
  const [cmd = 'help', ...args] = process.argv.slice(2);
  ADB_BIN = findAdb() || 'adb';
  let cfg = existsSync(CFG_FILE) ? loadConfig() : { url: 'http://127.0.0.1:18765/mcp' };

  switch (cmd) {
    case 'bootstrap': {
      const r = bootstrap({ install: args.includes('--install'), json: args.includes('--json') });
      process.exitCode = r.path === 'blocked' ? 2 : 0;
      return;
    }

    case 'sync':
      await sync(cfg);
      return;

    case 'tools': {
      if (!cfg.token) cfg = await sync(cfg);
      const r = await rpc(cfg, 'tools/list', {});
      for (const t of r.tools) console.log(`- ${t.name}: ${(t.description || '').split('\n')[0].slice(0, 90)}`);
      return;
    }

    case 'call': {
      if (!cfg.token) cfg = await sync(cfg);
      const [name, raw] = args;
      if (!name) fail('用法：call <tool> [json]');
      console.log(JSON.stringify(await call(cfg, name, raw ? JSON.parse(raw) : {}), null, 2));
      return;
    }

    case 'state': {
      if (!cfg.token) cfg = await sync(cfg);
      console.log(JSON.stringify(unwrap(await rpc(cfg, 'tools/call', { name: 'mika_device_state', arguments: {} })), null, 2));
      return;
    }

    case 'run': {
      if (!cfg.token) cfg = await sync(cfg);
      const goal = args[0];
      if (!goal) fail('用法：run "<任务描述>" [--conversation <id>]');
      const i = args.indexOf('--conversation');
      const conversation = i > -1 ? args[i + 1] : undefined;
      const r = await call(cfg, 'mika_run_task', { goal, ...(conversation ? { conversation } : {}) });
      console.log(`✓ 已下发 task_id=${r.task_id}${r.conversation ? ` conversation=${r.conversation}` : ''}`);
      return;
    }

    case 'do': {
      if (!cfg.token) cfg = await sync(cfg);
      const goal = args[0];
      if (!goal) fail('用法：do "<任务描述>" [--conversation <id>] [--timeout 50]');
      const i = args.indexOf('--conversation');
      const conversation = i > -1 ? args[i + 1] : undefined;
      const t = args.indexOf('--timeout');
      const timeout = t > -1 ? Number(args[t + 1]) : 50;
      const r = await call(cfg, 'mika_run_task', { goal, ...(conversation ? { conversation } : {}) });
      console.log(`→ task ${r.task_id}`);
      const s = await waitTask(cfg, r.task_id, { timeout });
      printResult(s);
      process.exitCode = s.status === 'done' ? 0 : 2;
      return;
    }

    case 'wait': {
      if (!cfg.token) cfg = await sync(cfg);
      const id = args[0];
      if (!id) fail('用法：wait <task_id> [--timeout 50]');
      const t = args.indexOf('--timeout');
      printResult(await waitTask(cfg, id, { timeout: t > -1 ? Number(args[t + 1]) : 50 }));
      return;
    }

    case 'status': {
      if (!cfg.token) cfg = await sync(cfg);
      printResult(await call(cfg, 'mika_task_status', { task_id: args[0] }));
      return;
    }

    case 'answer': {
      if (!cfg.token) cfg = await sync(cfg);
      const [id, ...rest] = args;
      if (!id || !rest.length) fail('用法：answer <task_id> "<回答>"');
      console.log(JSON.stringify(await call(cfg, 'mika_answer', { task_id: id, text: rest.join(' ') }), null, 2));
      return;
    }

    case 'steer': {
      if (!cfg.token) cfg = await sync(cfg);
      const [id, ...rest] = args;
      if (!id || !rest.length) fail('用法：steer <task_id> "<补充指令>"');
      console.log(JSON.stringify(await call(cfg, 'mika_steer_task', { task_id: id, text: rest.join(' ') }), null, 2));
      return;
    }

    case 'cancel': {
      if (!cfg.token) cfg = await sync(cfg);
      console.log(JSON.stringify(await call(cfg, 'mika_cancel_task', { task_id: args[0] }), null, 2));
      return;
    }

    case 'tasks': {
      if (!cfg.token) cfg = await sync(cfg);
      console.log(JSON.stringify(await call(cfg, 'mika_list_tasks', { limit: Number(args[0] || 10) }), null, 2));
      return;
    }

    case 'flow': {
      if (!cfg.token) cfg = await sync(cfg);
      const file = args.find((a) => !a.startsWith('--'));
      if (!file) fail('用法：flow <flows/x.json> [--from <stepId>] [--conversation <id>]');
      const spec = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'));
      const fromIdx = (() => {
        const i = args.indexOf('--from');
        if (i < 0) return 0;
        const idx = spec.steps.findIndex((s) => s.id === args[i + 1]);
        if (idx < 0) fail(`没有这一步：${args[i + 1]}`);
        return idx;
      })();
      const ci = args.indexOf('--conversation');
      let conversation = ci > -1 ? args[ci + 1] : spec.conversation;

      console.log(`▶ ${spec.name || file}（${spec.steps.length} 步，从「${spec.steps[fromIdx].id}」开始）`);
      for (const step of spec.steps.slice(fromIdx)) {
        console.log(`\n── ${step.id} ──`);
        if (step.gate) {
          console.log(`⏸ 闸门：${step.gate_note || '不可逆动作前停手，先向用户回报证据'}`);
          console.log(`   下一步指令：node ${process.argv[1]} flow ${file} --from ${step.id}`);
          if (conversation) console.log(`   conversation: ${conversation}`);
          process.exitCode = 3;
          return;
        }
        const r = await call(cfg, 'mika_run_task', { goal: step.goal, ...(conversation ? { conversation } : {}) });
        conversation = r.conversation || conversation;
        console.log(`→ task ${r.task_id}`);
        const s = await waitTask(cfg, r.task_id, { timeout: step.timeout || 50 });
        printResult(s);
        if (s.status !== 'done') {
          console.error(`✗ 第 ${step.id} 步没完成（${s.status}）`);
          process.exitCode = 2;
          return;
        }
        const blob = JSON.stringify(s);
        const miss = (step.expect_any || []).filter((k) => !blob.includes(k));
        if (step.expect_any?.length && miss.length === (step.expect_any || []).length) {
          console.error(`✗ 预期关键词一个都没出现：${step.expect_any.join(' / ')}`);
          process.exitCode = 2;
          return;
        }
      }
      console.log('\n✓ 全部步骤完成');
      process.exitCode = 0;
      return;
    }

    default:
      console.log(`mika.mjs — 通过 USB 驱动 Mika

  bootstrap [--install] [--json]
                           第 0 步自检：adb / 设备 / Mika 三件事，决定走哪条通道
  sync                     从手机取 token、做 adb 转发、检查解锁与手机助手
  state                    读设备状态（锁屏/助手是否就绪）
  tools                    列出 Mika 暴露的 MCP 工具
  call <tool> [json]       直接调一个工具
  run "<goal>"            下发任务，立刻返回 task_id
  do  "<goal>"            下发并等到结束（含等待/提问/失败）
  wait <task_id>  [--timeout 50]
  status <task_id>
  answer <task_id> "<回答>"
  steer  <task_id> "<补充指令>"
  cancel <task_id>
  tasks [limit]
  flow <flows/x.json> [--from <stepId>] [--conversation <id>]
                          按流程文件逐步下发，遇到 gate 停下（退出码 3）
`);
  }
}

main().catch((e) => fail(e?.stack ? e.stack.split('\n').slice(0, 4).join('\n') : String(e)));
