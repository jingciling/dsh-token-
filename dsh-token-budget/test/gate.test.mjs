/**
 * Host-half contract tests for dsh-token-budget.
 *
 * These run against a stubbed Cordis context, so they need no Harness runtime:
 *   node test/gate.test.mjs
 * (`node --test` also works but spawns a child process per file; under a
 * process-restricted sandbox plain `node <file>` is the reliable form.)
 *
 * `DSH_HOME` is redirected to a temp directory so the real ledger is untouched;
 * every harness gets its own directory, so tests never share a ledger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { apply } = await import('../index.js');

function harness(config, home = mkdtempSync(join(tmpdir(), 'dsh-token-budget-test-'))) {
  process.env.DSH_HOME = home;
  const listeners = new Map();
  const routes = new Map();
  const disposers = [];
  /** @type {object[]} */
  const effects = [];

  const host = {
    webServer: {
      register(route) {
        assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`);
        routes.set(route.path, route.handler);
        return () => routes.delete(route.path);
      },
    },
    effect(callback) {
      const dispose = callback();
      effects.push(dispose);
      return dispose;
    },
  };

  const ctx = {
    on(event, handler) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(handler);
      listeners.set(event, bucket);
      return () => {};
    },
    inject(dependencies, callback) {
      assert.deepEqual(dependencies, ['webServer']);
      callback(host);
    },
  };

  apply(ctx, config);

  const emit = (event, ...args) => {
    for (const handler of listeners.get(event) ?? []) handler(...args);
  };
  const route = (path) => routes.get(path);
  const gate = (exec = { name: 'read', callId: 'call-1' }) => {
    let nextCalls = 0;
    const next = async () => {
      nextCalls += 1;
      return { kind: 'allow' };
    };
    const handler = (listeners.get('tools/pre-execute') ?? [])[0];
    assert.ok(handler, 'tools/pre-execute listener registered');
    return { decision: handler(exec, next), calls: () => nextCalls };
  };

  const dispose = () => {
    for (const fn of effects) fn?.();
    for (const handler of listeners.get('dispose') ?? []) handler();
  };

  return { ctx, listeners, routes, route, emit, gate, dispose, home };
}

function assistant(usage) {
  return ['session', { type: 'assistant/message', seq: 1, time: Date.now(), data: { usage } }];
}

async function status(h) {
  const handler = h.route('/dsh-token-budget/status');
  assert.ok(handler, 'status route registered');
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(body) {
      this.body = body ?? '';
    },
  };
  await handler({ method: 'GET', on() {} }, response);
  return { code: response.statusCode, json: JSON.parse(response.body) };
}

test('records usage from assistant/message events and ignores other events', async () => {
  const h = harness({ dailyLimit: 1000 });
  h.emit('session/event', {}, { type: 'assistant/message', data: { usage: { inputTokens: 300, outputTokens: 100 } } });
  h.emit('session/event', {}, { type: 'assistant/message', data: {} });
  h.emit('session/event', {}, { type: 'tool/call', data: {} });
  const { code, json } = await status(h);
  assert.equal(code, 200);
  assert.equal(json.total, 400);
  assert.equal(json.input, 300);
  assert.equal(json.output, 100);
  assert.equal(json.requests, 1);
  h.dispose();
});

test('warns at the configured ratio but keeps running', async () => {
  const h = harness({ dailyLimit: 1000, warnRatio: 0.5 });
  h.emit('session/event', ...assistant({ inputTokens: 400, outputTokens: 150 }));
  const { json } = await status(h);
  assert.equal(json.warn, true);
  assert.equal(json.over, false);
  assert.equal(json.ackWarn, false);
  const { decision } = h.gate();
  assert.equal((await decision).kind, 'allow');
  h.dispose();
});

test('asks whether to continue once the budget is used up, then grants a grace window', async () => {
  const h = harness({ dailyLimit: 1000, graceMinutes: 5 });
  h.emit('session/event', ...assistant({ inputTokens: 600, outputTokens: 600 }));

  const first = h.gate();
  const decision = await first.decision;
  assert.equal(decision.kind, 'ask');
  assert.match(decision.reason, /1\.0k/);
  assert.match(decision.reason, /120%/);
  assert.equal(first.calls(), 0);
  assert.ok(decision.displayReason.en.length > 0);
  assert.ok(decision.displayReason.zh.length > 0);

  const second = h.gate();
  assert.equal((await second.decision).kind, 'allow');
  assert.equal(second.calls(), 1);
  h.dispose();
});

test('"今天停止" denies tools until the day is reset', async () => {
  const h = harness({ dailyLimit: 1000 });
  h.emit('session/event', ...assistant({ inputTokens: 900, outputTokens: 900 }));

  const stop = h.route('/dsh-token-budget/stop');
  const response = { statusCode: 0, body: '', writeHead(code) { this.statusCode = code; }, end(body) { this.body = body ?? ''; } };
  await stop({ method: 'POST', on() {} }, response);
  assert.equal(response.statusCode, 200);

  const blocked = h.gate();
  const decision = await blocked.decision;
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.info.code, 'daily-token-budget-stopped');
  assert.equal(blocked.calls(), 0);

  const reset = h.route('/dsh-token-budget/reset');
  const resetResponse = { statusCode: 0, body: '', writeHead(code) { this.statusCode = code; }, end(body) { this.body = body ?? ''; } };
  await reset({ method: 'POST', on() {} }, resetResponse);
  const after = await status(h);
  assert.equal(after.json.total, 0);
  assert.equal(after.json.stopped, false);
  h.dispose();
});

test('hard-stops instead of asking above hardStopRatio', async () => {
  const h = harness({ dailyLimit: 1000, hardStopRatio: 1.5 });
  h.emit('session/event', ...assistant({ inputTokens: 1000, outputTokens: 800 }));
  const { decision } = h.gate();
  const resolved = await decision;
  assert.equal(resolved.kind, 'deny');
  assert.equal(resolved.info.code, 'daily-token-budget-hard-stop');
  h.dispose();
});

test('config overrides persist and reach the snapshot', async () => {
  const h = harness({ dailyLimit: 1000 });
  const handler = h.route('/dsh-token-budget/config');
  const body = JSON.stringify({ dailyLimit: 5000, warnRatio: 0.9 });
  const request = {
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body);
    },
  };
  const response = { statusCode: 0, body: '', writeHead(code) { this.statusCode = code; }, end(value) { this.body = value ?? ''; } };
  await handler(request, response);
  assert.equal(response.statusCode, 200);
  const json = JSON.parse(response.body);
  assert.equal(json.limit, 5000);
  assert.equal(json.warnAt, 4500);
  h.dispose();
});

test('persists the ledger atomically and reloads it', async () => {
  const h = harness({ dailyLimit: 1000 });
  h.emit('session/event', ...assistant({ inputTokens: 42, outputTokens: 8 }));
  h.dispose(); // flushes on dispose

  const file = join(h.home, 'token-budget', 'ledger.json');
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  const today = Object.values(ledger.days)[0];
  assert.equal(today.input, 42);
  assert.equal(today.output, 8);

  const again = harness({ dailyLimit: 1000 }, h.home);
  const { json } = await status(again);
  assert.equal(json.total, 50);
  again.dispose();
});
