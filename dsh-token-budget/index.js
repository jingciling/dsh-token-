/**
 * dsh-token-budget — 每日 Token 预算守卫（Host 半）。
 *
 * 职责：
 * 1. 从 `session/event`(`assistant/message`) 的 `usage` 累计当天已消耗 token；
 * 2. 把账本持久化到 `<DSH_HOME>/token-budget/ledger.json`，重启不丢；
 * 3. 越过 `warnRatio` 时通过 `/dsh-token-budget/status` 让页面弹出提示；
 * 4. 用完额度后，如果 Agent 还在工作，下一次工具调用会走审批询问
 *    “是否继续运行”（`tools/pre-execute` 返回 `ask`）；
 * 5. 超过 `hardStopRatio` 后直接拒绝工具调用，避免失控循环继续烧 token。
 *
 * Client 半（./client.js）只负责渲染：徽标、提示、继续/停止面板。
 * 两者通过 webServer 上的 JSON 路由通信，不依赖 host.call。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'dsh-token-budget';

const ROUTE = '/dsh-token-budget';
const KEEP_DAYS = 30;
const BODY_LIMIT = 16 * 1024;
const PERSIST_DELAY_MS = 400;

/** @type {Record<string, number>} */
const DEFAULTS = {
  dailyLimit: 2_000_000,
  warnRatio: 0.8,
  graceMinutes: 10,
  hardStopRatio: 1.25,
};

const CONFIG_KEYS = ['dailyLimit', 'warnRatio', 'graceMinutes', 'hardStopRatio'];

/** The DSH home directory (`DSH_HOME` when the launcher sets it). */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return join(homedir(), '.dsh');
}

function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function emptyDay() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    requests: 0,
    updatedAt: 0,
  };
}

function emptyLedger() {
  return {
    version: 1,
    days: {},
    meta: {
      /** @type {string | undefined} last day the warning was acknowledged */
      ackWarnDay: undefined,
      /** @type {string | undefined} day the user pressed "今天停止" */
      stoppedDay: undefined,
      /** @type {number} epoch ms until which tool calls run without asking */
      graceUntil: 0,
      /** @type {Record<string, number>} runtime overrides written by the panel */
      overrides: {},
    },
  };
}

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ratio01(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed > 1 ? fallback : parsed;
}

function pickConfig(raw) {
  /** @type {Record<string, number>} */
  const picked = {};
  if (raw === null || typeof raw !== 'object') return picked;
  for (const key of CONFIG_KEYS) {
    if (!(key in raw)) continue;
    const value = Number(raw[key]);
    if (!Number.isFinite(value) || value < 0) continue;
    if (key === 'dailyLimit' && value === 0) continue;
    if (key === 'warnRatio' && value > 1) continue;
    if (key === 'hardStopRatio' && value < 1) continue;
    picked[key] = value;
  }
  return picked;
}

function json(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request, maxBytes = BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  return JSON.parse(text);
}

/**
 * Register the budget guard on one host context.
 * @param ctx - Host context; `webServer` is acquired lazily.
 * @param config - Bundle configuration from cordis.patch.yml.
 */
export function apply(ctx, config) {
  const file = join(dshHome(), 'token-budget', 'ledger.json');

  /** @type {{ ledger: ReturnType<typeof emptyLedger>; file: string; patch: Record<string, number>; running: Set<string>; persistTimer: ReturnType<typeof setTimeout> | undefined; warned: boolean }} */
  const state = {
    ledger: loadLedger(file),
    file,
    patch: pickConfig(config),
    running: new Set(),
    persistTimer: undefined,
    warned: false,
  };

  function effective() {
    const overrides = state.ledger.meta.overrides ?? {};
    return {
      dailyLimit: positive(overrides.dailyLimit ?? state.patch.dailyLimit, DEFAULTS.dailyLimit),
      warnRatio: ratio01(overrides.warnRatio ?? state.patch.warnRatio, DEFAULTS.warnRatio),
      graceMinutes: positive(overrides.graceMinutes ?? state.patch.graceMinutes, DEFAULTS.graceMinutes),
      hardStopRatio: positive(overrides.hardStopRatio ?? state.patch.hardStopRatio, DEFAULTS.hardStopRatio),
    };
  }

  function day(key = localDayKey()) {
    const existing = state.ledger.days[key];
    if (existing && typeof existing === 'object') return existing;
    const created = emptyDay();
    state.ledger.days[key] = created;
    return created;
  }

  function persistNow() {
    state.persistTimer = undefined;
    pruneDays(state.ledger);
    try {
      mkdirSync(dirname(state.file), { recursive: true });
      const temp = `${state.file}.tmp`;
      writeFileSync(temp, `${JSON.stringify(state.ledger, null, 2)}\n`, 'utf8');
      renameSync(temp, state.file);
    } catch (error) {
      console.warn(`[dsh-token-budget] 无法写入账本 ${state.file}: ${error?.message ?? error}`);
    }
  }

  function queuePersist() {
    if (state.persistTimer !== undefined) return;
    state.persistTimer = setTimeout(persistNow, PERSIST_DELAY_MS);
    state.persistTimer.unref?.();
  }

  function snapshot() {
    const cfg = effective();
    const key = localDayKey();
    const today = day(key);
    const meta = state.ledger.meta;
    const total = today.input + today.output;
    const ratio = cfg.dailyLimit > 0 ? total / cfg.dailyLimit : 0;
    const graceUntil = Number(meta.graceUntil) || 0;
    const stopped = meta.stoppedDay === key;
    return {
      date: key,
      limit: cfg.dailyLimit,
      warnAt: Math.round(cfg.dailyLimit * cfg.warnRatio),
      total,
      input: today.input,
      output: today.output,
      cacheRead: today.cacheRead,
      cacheWrite: today.cacheWrite,
      reasoning: today.reasoning,
      requests: today.requests,
      ratio,
      warn: ratio >= cfg.warnRatio,
      over: total >= cfg.dailyLimit,
      ackWarn: meta.ackWarnDay === key,
      warned: state.warned,
      stopped,
      graceUntil,
      graceActive: !stopped && graceUntil > Date.now(),
      graceMinutes: cfg.graceMinutes,
      warnRatio: cfg.warnRatio,
      hardStopRatio: cfg.hardStopRatio,
      running: state.running.size,
      history: history(cfg, key),
      ledgerPath: state.file,
    };
  }

  function history(cfg, todayKey) {
    const keys = Object.keys(state.ledger.days).sort();
    const recent = keys.slice(-7);
    if (!recent.includes(todayKey)) recent.push(todayKey);
    return recent.sort().map((key) => {
      const value = state.ledger.days[key] ?? emptyDay();
      return { date: key, total: value.input + value.output };
    });
  }

  function grantGrace(minutes) {
    const cfg = effective();
    const ms = minutes === undefined ? cfg.graceMinutes : Math.max(0, Number(minutes) || 0) * 60_000;
    const now = Date.now();
    state.ledger.meta.graceUntil = Math.max(Number(state.ledger.meta.graceUntil) || 0, now + ms);
    state.ledger.meta.stoppedDay = undefined;
    state.warned = false;
    queuePersist();
    return state.ledger.meta.graceUntil;
  }

  function stopToday() {
    state.ledger.meta.stoppedDay = localDayKey();
    state.ledger.meta.graceUntil = 0;
    queuePersist();
  }

  /** Record one usage report from an assistant message. */
  function record(usage) {
    if (!usage || typeof usage !== 'object') return;
    const key = localDayKey();
    const today = day(key);
    today.input += positive(usage.inputTokens, 0);
    today.output += positive(usage.outputTokens, 0);
    today.cacheRead += positive(usage.cacheReadTokens, 0);
    today.cacheWrite += positive(usage.cacheWriteTokens, 0);
    today.reasoning += positive(usage.reasoningTokens, 0);
    today.requests += 1;
    today.updatedAt = Date.now();
    // 新的一天：警告确认与“今天停止”都属于旧的一天，自然失效。
    const meta = state.ledger.meta;
    if (meta.stoppedDay !== undefined && meta.stoppedDay !== key) meta.stoppedDay = undefined;
    if (meta.ackWarnDay !== undefined && meta.ackWarnDay !== key) meta.ackWarnDay = undefined;
    if (Number(meta.graceUntil) > 0 && meta.graceUntil < Date.now() - 86_400_000) meta.graceUntil = 0;
    queuePersist();
    maybeWarn(snapshot());
  }

  function maybeWarn(view) {
    if (state.warned) return;
    if (!view.warn) return;
    if (view.ackWarn) {
      state.warned = true;
      return;
    }
    state.warned = true;
    console.warn(
      `[dsh-token-budget] 今日已用 ${view.total} / ${view.limit} token（${Math.round(view.ratio * 100)}%）`,
    );
  }

  // ---- 账本 ----
  function loadLedger(path) {
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw);
      const ledger = emptyLedger();
      if (parsed && typeof parsed === 'object') {
        if (parsed.days && typeof parsed.days === 'object') {
          for (const [key, value] of Object.entries(parsed.days)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !value || typeof value !== 'object') continue;
            ledger.days[key] = { ...emptyDay(), ...pickNumbers(value) };
          }
        }
        if (parsed.meta && typeof parsed.meta === 'object') {
          ledger.meta = { ...ledger.meta, ...pickMeta(parsed.meta) };
        }
      }
      return ledger;
    } catch {
      return emptyLedger();
    }
  }

  function pickNumbers(value) {
    const out = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'requests', 'updatedAt']) {
      const n = Number(value[key]);
      if (Number.isFinite(n) && n >= 0) out[key] = n;
    }
    return out;
  }

  function pickMeta(value) {
    const out = {};
    if (typeof value.ackWarnDay === 'string') out.ackWarnDay = value.ackWarnDay;
    if (typeof value.stoppedDay === 'string') out.stoppedDay = value.stoppedDay;
    const grace = Number(value.graceUntil);
    if (Number.isFinite(grace) && grace > 0) out.graceUntil = grace;
    if (value.overrides && typeof value.overrides === 'object') {
      out.overrides = pickConfig(value.overrides);
    }
    return out;
  }

  // ---- 事件：计量 + 运行状态 ----
  // SessionEvent = { type, seq, time, data: SessionEventMap[type] }；用量在 data.usage 上。
  ctx.on('session/event', (_session, event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type !== 'assistant/message') return;
    record(event.data?.usage);
  });

  ctx.on('agent/status', (payload) => {
    const id = payload?.agent?.id;
    if (id === undefined) return;
    if (payload.status === 'running') state.running.add(String(id));
    else state.running.delete(String(id));
  });

  // ---- 闸门：额度用完后询问 / 拒绝 ----
  ctx.on('tools/pre-execute', async (exec, next) => {
    const view = snapshot();
    if (!view.over) return next();

    const zhUsed = `今日已用 ${formatTokens(view.total)} / ${formatTokens(view.limit)} token（${Math.round(view.ratio * 100)}%）。`;

    if (view.stopped) {
      return deny(
        `Token 预算：${zhUsed}你已选择“今天停止”，本次工具调用被拒绝。需要继续时，请点击页面右下角的 Token 预算徽标并选择“继续运行”。`,
        'daily-token-budget-stopped',
      );
    }
    if (view.graceActive) return next();

    if (view.ratio >= view.hardStopRatio) {
      return deny(
        `Token 预算：${zhUsed}已超过硬上限（${Math.round(view.hardStopRatio * 100)}%），本次工具调用被拒绝，以免继续消耗。请先结束当前任务或调高每日上限。`,
        'daily-token-budget-hard-stop',
      );
    }

    // 询问是否继续：放行一段时间的额度，避免每个工具调用都弹一次。
    grantGrace(view.graceMinutes);
    console.warn(`[dsh-token-budget] ${zhUsed}正在询问是否继续运行`);
    return {
      kind: 'ask',
      reason: `${zhUsed}${view.running > 0 ? '当前任务仍在运行。' : ''}是否继续运行？允许后 ${view.graceMinutes} 分钟内不再询问。`,
      displayReason: {
        en: `Daily token budget used up (${formatTokens(view.total)} / ${formatTokens(view.limit)}). ${view.running > 0 ? 'A turn is running. ' : ''}Continue running? Tools are allowed for ${view.graceMinutes} minutes after approval.`,
        zh: `${zhUsed}${view.running > 0 ? '当前任务仍在运行。' : ''}是否继续运行？允许后 ${view.graceMinutes} 分钟内不再询问。`,
      },
    };
  });

  ctx.on('dispose', () => {
    if (state.persistTimer !== undefined) {
      clearTimeout(state.persistTimer);
      state.persistTimer = undefined;
    }
    persistNow();
  });

  // ---- HTTP：给页面用的 JSON 接口 ----
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const server = host.webServer;
      const disposers = [
        server.register({
          kind: 'exact',
          path: `${ROUTE}/status`,
          handler: (request, response) => {
            if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
            json(response, 200, snapshot());
          },
        }),
        server.register({
          kind: 'exact',
          path: `${ROUTE}/continue`,
          handler: async (request, response) => {
            if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
            try {
              const body = await readJson(request);
              const minutes = body?.minutes === undefined ? undefined : Number(body.minutes);
              grantGrace(Number.isFinite(minutes) ? minutes : undefined);
              json(response, 200, snapshot());
            } catch (error) {
              json(response, 400, { error: `${error?.message ?? error}` });
            }
          },
        }),
        server.register({
          kind: 'exact',
          path: `${ROUTE}/stop`,
          handler: (request, response) => {
            if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
            stopToday();
            json(response, 200, snapshot());
          },
        }),
        server.register({
          kind: 'exact',
          path: `${ROUTE}/ack-warn`,
          handler: (request, response) => {
            if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
            state.ledger.meta.ackWarnDay = localDayKey();
            state.warned = true;
            queuePersist();
            json(response, 200, snapshot());
          },
        }),
        server.register({
          kind: 'exact',
          path: `${ROUTE}/config`,
          handler: async (request, response) => {
            if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
            try {
              const body = await readJson(request);
              const picked = pickConfig(body);
              if (Object.keys(picked).length === 0) {
                json(response, 400, { error: '没有可用的配置项（dailyLimit / warnRatio / graceMinutes / hardStopRatio）' });
                return;
              }
              state.ledger.meta.overrides = { ...(state.ledger.meta.overrides ?? {}), ...picked };
              queuePersist();
              json(response, 200, snapshot());
            } catch (error) {
              json(response, 400, { error: `${error?.message ?? error}` });
            }
          },
        }),
        server.register({
          kind: 'exact',
          path: `${ROUTE}/reset`,
          handler: (request, response) => {
            if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
            const key = localDayKey();
            state.ledger.days[key] = emptyDay();
            state.ledger.meta.graceUntil = 0;
            state.ledger.meta.stoppedDay = undefined;
            state.ledger.meta.ackWarnDay = undefined;
            state.warned = false;
            queuePersist();
            json(response, 200, snapshot());
          },
        }),
      ];
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.();
          } catch {
            /* the server may already be gone */
          }
        }
      };
    }, 'dsh-token-budget: JSON routes');
  });
}

function methodNotAllowed(response, allow) {
  response.writeHead(405, { allow });
  response.end();
}

function deny(reason, code) {
  return {
    kind: 'deny',
    reason,
    info: { name: 'dsh-token-budget', code, reason },
  };
}

function formatTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

function pruneDays(ledger) {
  const keys = Object.keys(ledger.days).sort();
  const cutoff = localDayKey(new Date(Date.now() - KEEP_DAYS * 86_400_000));
  for (const key of keys) {
    if (key < cutoff) delete ledger.days[key];
  }
}
