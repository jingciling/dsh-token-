/**
 * dsh-token-budget — 每日 Token 预算守卫（Client 半）。
 *
 * 这一半只做三件事：
 *   1. 在 `shell.overlay` 里常驻一个预算胶囊，点击展开当日明细面板；
 *   2. 达到提醒阈值时弹出轻提示，额度用完时弹出“继续运行 / 今天停止”询问；
 *   3. 把用户的选择回传给 Host（POST `/dsh-token-budget/*`）。
 *
 * 语言：界面文案直接使用中文（本部署的 Web GUI 语言），不引入 locale 依赖。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-token-budget',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const ROUTE = 'dsh-token-budget';
    const POLL_MS = 4000;

    const COLORS = {
      ok: '#2f9e6e',
      warn: '#d98324',
      over: '#d64545',
      muted: 'rgba(128,128,128,0.75)',
      surface: 'rgba(128,128,128,0.14)',
      border: 'rgba(128,128,128,0.28)',
    };

    // ---- 与 Host 通信 ----
    function endpoint(path) {
      try {
        return new URL(`${ROUTE}${path}`, new URL('.', document.baseURI)).href;
      } catch {
        return `/${ROUTE}${path}`;
      }
    }

    async function request(path, init) {
      const response = await fetch(endpoint(path), {
        credentials: 'same-origin',
        cache: 'no-store',
        ...init,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ''}`);
      }
      return response.json();
    }

    const post = (path, body) =>
      request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });

    // ---- 轮询 ----
    function useBudget() {
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);

      const refresh = useCallback(async () => {
        try {
          const next = await request('/status');
          setState(next);
          setError(null);
          return next;
        } catch (cause) {
          setError(cause?.message ?? String(cause));
          return null;
        }
      }, []);

      useEffect(() => {
        let disposed = false;
        const tick = () => {
          if (disposed) return;
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          void refresh();
        };
        tick();
        const timer = setInterval(tick, POLL_MS);
        const onVisibility = () => {
          if (document.visibilityState === 'visible') tick();
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
          disposed = true;
          clearInterval(timer);
          document.removeEventListener('visibilitychange', onVisibility);
        };
      }, [refresh]);

      return { state, error, refresh };
    }

    // ---- 小工具 ----
    function formatTokens(value) {
      const n = Number(value) || 0;
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
      if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
      return String(n);
    }

    function tone(state) {
      if (!state) return 'ok';
      if (state.stopped) return 'over';
      if (state.over) return 'warn';
      if (state.warn) return 'warn';
      return 'ok';
    }

    function percent(state) {
      if (!state) return 0;
      return Math.max(0, Math.min(100, Math.round((state.ratio ?? 0) * 100)));
    }

    function remainingMinutes(state) {
      if (!state?.graceActive) return 0;
      return Math.max(0, Math.ceil((state.graceUntil - Date.now()) / 60_000));
    }

    function clockText(ms) {
      try {
        return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      } catch {
        return '';
      }
    }

    function style(options) {
      return Object.assign(
        {
          font: 'inherit',
          color: 'inherit',
          boxSizing: 'border-box',
        },
        options,
      );
    }

    // ---- 进度条 ----
    function Bar({ state, height = 6 }) {
      const pct = percent(state);
      const color = COLORS[state?.over ? 'over' : state?.warn ? 'warn' : 'ok'];
      return h(
        'div',
        {
          style: style({
            position: 'relative',
            height,
            borderRadius: height,
            background: COLORS.surface,
            overflow: 'hidden',
          }),
        },
        h('div', {
          style: {
            position: 'absolute',
            inset: '0 auto 0 0',
            width: `${pct}%`,
            background: color,
            borderRadius: height,
            transition: 'width 300ms ease, background 300ms ease',
          },
        }),
      );
    }

    // ---- 常驻胶囊 ----
    function Pill({ state, open, onToggle }) {
      const color = COLORS[tone(state)];
      const label = state
        ? `今日 ${formatTokens(state.total)} / ${formatTokens(state.limit)}`
        : 'Token 预算';
      return h(
        'button',
        {
          type: 'button',
          onClick: onToggle,
          title: state
            ? `${label}（${percent(state)}%）${state.stopped ? ' · 今天已停止' : ''}`
            : '打开 Token 预算面板',
          'aria-expanded': open,
          style: style({
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            borderRadius: 999,
            border: `1px solid ${open ? color : COLORS.border}`,
            background: COLORS.surface,
            backdropFilter: 'blur(10px)',
            cursor: 'pointer',
            fontSize: 11.5,
            lineHeight: 1.2,
            fontVariantNumeric: 'tabular-nums',
            boxShadow: open ? `0 0 0 2px ${color}40` : 'none',
            transition: 'border-color 200ms ease, box-shadow 200ms ease',
          }),
        },
        h('span', {
          style: {
            width: 8,
            height: 8,
            borderRadius: 999,
            background: color,
            boxShadow: `0 0 0 3px ${color}26`,
          },
        }),
        h('span', null, state ? `${percent(state)}%` : '—'),
        h('span', { style: { color: COLORS.muted } }, label),
      );
    }

    // ---- 明细面板 ----
    function Panel({ state, error, busy, onAction, onClose, onRefresh }) {
      const [limitDraft, setLimitDraft] = useState('');
      const [warnDraft, setWarnDraft] = useState('');
      const [notice, setNotice] = useState(null);

      useEffect(() => {
        if (!state) return;
        setLimitDraft(String(state.limit));
        setWarnDraft(String(Math.round((state.warnRatio ?? 0.8) * 100)));
      }, [state?.limit, state?.warnRatio]);

      const save = async () => {
        const dailyLimit = Number(limitDraft);
        const warnPercent = Number(warnDraft);
        if (!Number.isFinite(dailyLimit) || dailyLimit <= 0) {
          setNotice('每日上限必须是正数');
          return;
        }
        const patch = { dailyLimit };
        if (Number.isFinite(warnPercent) && warnPercent > 0 && warnPercent <= 100) {
          patch.warnRatio = warnPercent / 100;
        }
        setNotice(null);
        await onAction('config', patch);
        setNotice('已保存');
      };

      const rows = state
        ? [
            ['输入', formatTokens(state.input)],
            ['输出', formatTokens(state.output)],
            ['缓存读', formatTokens(state.cacheRead)],
            ['请求', String(state.requests ?? 0)],
          ]
        : [];

      const history = Array.isArray(state?.history) ? state.history : [];
      const maxHistory = Math.max(1, ...history.map((entry) => entry.total), state?.limit ?? 0);

      return h(
        'div',
        {
          onClick: (event) => event.stopPropagation(),
          style: style({
            position: 'fixed',
            right: 20,
            bottom: 68,
            width: 320,
            padding: 14,
            borderRadius: 14,
            border: `1px solid ${COLORS.border}`,
            background: 'Canvas',
            color: 'CanvasText',
            boxShadow: '0 12px 40px rgba(0,0,0,0.28)',
            pointerEvents: 'auto',
            display: 'grid',
            gap: 10,
            fontSize: 12,
          }),
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
          h('strong', { style: { fontSize: 13 } }, '今日 Token 预算'),
          h(
            'button',
            {
              type: 'button',
              onClick: onClose,
              'aria-label': '关闭',
              style: style({ border: 0, background: 'transparent', cursor: 'pointer', color: COLORS.muted, fontSize: 14 }),
            },
            '×',
          ),
        ),

        error
          ? h('div', { style: { color: COLORS.over } }, `Host 不可达：${error}`)
          : null,

        state
          ? h(
              'div',
              { style: { display: 'grid', gap: 6 } },
              h(
                'div',
                { style: { display: 'flex', justifyContent: 'space-between', fontVariantNumeric: 'tabular-nums' } },
                h('span', null, `${formatTokens(state.total)} / ${formatTokens(state.limit)}`),
                h('span', { style: { color: COLORS.muted } }, `${percent(state)}%`),
              ),
              h(Bar, { state }),
              state.stopped
                ? h('div', { style: { color: COLORS.over } }, '今天已停止：工具调用会被拒绝，直到你继续运行或重置。')
                : null,
              state.graceActive
                ? h('div', { style: { color: COLORS.warn } },
                    `已允许继续运行，剩余约 ${remainingMinutes(state)} 分钟（至 ${clockText(state.graceUntil)}）。`)
                : null,
            )
          : h('div', { style: { color: COLORS.muted } }, '正在读取账本…'),

        state
          ? h(
              'div',
              {
                style: {
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: 6,
                  padding: '8px 0',
                  borderTop: `1px solid ${COLORS.border}`,
                  borderBottom: `1px solid ${COLORS.border}`,
                  fontVariantNumeric: 'tabular-nums',
                },
              },
              rows.map(([label, value]) =>
                h(
                  'div',
                  { key: label, style: { display: 'grid', gap: 2 } },
                  h('span', { style: { color: COLORS.muted, fontSize: 10.5 } }, label),
                  h('span', { style: { fontSize: 12.5 } }, value),
                ),
              ),
            )
          : null,

        history.length > 0
          ? h(
              'div',
              { style: { display: 'grid', gap: 4 } },
              h('span', { style: { color: COLORS.muted, fontSize: 10.5 } }, '近 7 天'),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'flex-end', gap: 4, height: 34 } },
                history.map((entry) =>
                  h(
                    'div',
                    {
                      key: entry.date,
                      title: `${entry.date} · ${formatTokens(entry.total)}`,
                      style: {
                        flex: 1,
                        height: Math.max(3, Math.round((entry.total / maxHistory) * 34)),
                        borderRadius: 3,
                        background: entry.total >= (state?.limit ?? Infinity) ? COLORS.over : COLORS.ok,
                        opacity: entry.date === state?.date ? 1 : 0.45,
                      },
                    },
                  ),
                ),
              ),
            )
          : null,

        h(
          'div',
          { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: () => onAction('continue', {}),
              style: style({
                flex: 1,
                padding: '6px 10px',
                borderRadius: 8,
                border: `1px solid ${COLORS.ok}`,
                background: `${COLORS.ok}18`,
                color: 'inherit',
                cursor: busy ? 'progress' : 'pointer',
              }),
            },
            state?.graceActive ? '延长继续时间' : `继续运行 ${state?.graceMinutes ?? 10} 分钟`,
          ),
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: () => onAction('stop', {}),
              style: style({
                flex: 1,
                padding: '6px 10px',
                borderRadius: 8,
                border: `1px solid ${COLORS.over}`,
                background: `${COLORS.over}18`,
                color: 'inherit',
                cursor: busy ? 'progress' : 'pointer',
              }),
            },
            '今天停止',
          ),
        ),

        h(
          'div',
          { style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h('span', { style: { color: COLORS.muted, whiteSpace: 'nowrap', fontSize: 11 } }, '上限'),
          h('input', {
            type: 'number',
            min: 1,
            step: 100000,
            value: limitDraft,
            onChange: (event) => setLimitDraft(event.target.value),
            style: style({
              flex: 1,
              minWidth: 0,
              padding: '4px 6px',
              borderRadius: 6,
              border: `1px solid ${COLORS.border}`,
              background: 'transparent',
              fontVariantNumeric: 'tabular-nums',
            }),
          }),
          h('span', { style: { color: COLORS.muted, whiteSpace: 'nowrap', fontSize: 11 } }, '提醒'),
          h('input', {
            type: 'number',
            min: 1,
            max: 100,
            step: 5,
            value: warnDraft,
            onChange: (event) => setWarnDraft(event.target.value),
            style: style({
              width: 52,
              padding: '4px 6px',
              borderRadius: 6,
              border: `1px solid ${COLORS.border}`,
              background: 'transparent',
              fontVariantNumeric: 'tabular-nums',
            }),
          }),
          h('span', { style: { color: COLORS.muted, fontSize: 11 } }, '%'),
          h(
            'button',
            {
              type: 'button',
              onClick: save,
              style: style({
                padding: '4px 10px',
                borderRadius: 6,
                border: `1px solid ${COLORS.border}`,
                background: 'transparent',
                cursor: 'pointer',
              }),
            },
            '保存',
          ),
        ),

        notice ? h('div', { style: { color: notice === '已保存' ? COLORS.ok : COLORS.over } }, notice) : null,

        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', gap: 8, color: COLORS.muted, fontSize: 10.5 } },
          h(
            'span',
            { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: state?.ledgerPath },
            state?.ledgerPath ?? '',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: () => onAction('reset', {}),
              style: style({ border: 0, background: 'transparent', color: COLORS.muted, cursor: 'pointer', fontSize: 10.5, whiteSpace: 'nowrap' }),
            },
            '重置今日',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: onRefresh,
              style: style({ border: 0, background: 'transparent', color: COLORS.muted, cursor: 'pointer', fontSize: 10.5 }),
            },
            '刷新',
          ),
        ),
      );
    }

    // ---- 提醒 / 询问 ----
    function OverModal({ state, busy, onAction, onClose }) {
      const running = (state?.running ?? 0) > 0;
      return h(
        'div',
        {
          style: style({
            position: 'fixed',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(0,0,0,0.38)',
            pointerEvents: 'auto',
            zIndex: 1,
          }),
          onClick: onClose,
        },
        h(
          'div',
          {
            onClick: (event) => event.stopPropagation(),
            style: style({
              width: 380,
              padding: 18,
              borderRadius: 16,
              border: `1px solid ${COLORS.border}`,
              background: 'Canvas',
              color: 'CanvasText',
              boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
              display: 'grid',
              gap: 12,
              fontSize: 12.5,
            }),
          },
          h('strong', { style: { fontSize: 14 } }, '今日 Token 预算已用完'),
          h(
            'div',
            { style: { color: COLORS.muted, lineHeight: 1.55 } },
            `已用 ${formatTokens(state?.total ?? 0)} / ${formatTokens(state?.limit ?? 0)} token（${percent(state)}%）。`,
            running ? ' 当前任务仍在运行。' : '',
            ' 是否继续运行？',
          ),
          h(Bar, { state, height: 8 }),
          h(
            'div',
            { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            h(
              'button',
              {
                type: 'button',
                onClick: onClose,
                style: style({
                  padding: '7px 14px',
                  borderRadius: 8,
                  border: `1px solid ${COLORS.border}`,
                  background: 'transparent',
                  cursor: 'pointer',
                }),
              },
              '稍后',
            ),
            h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => onAction('stop', {}),
                style: style({
                  padding: '7px 14px',
                  borderRadius: 8,
                  border: `1px solid ${COLORS.over}`,
                  background: `${COLORS.over}18`,
                  cursor: busy ? 'progress' : 'pointer',
                }),
              },
              '今天停止',
            ),
            h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => onAction('continue', {}),
                style: style({
                  padding: '7px 14px',
                  borderRadius: 8,
                  border: `1px solid ${COLORS.ok}`,
                  background: COLORS.ok,
                  color: '#fff',
                  cursor: busy ? 'progress' : 'pointer',
                }),
              },
              `继续运行 ${state?.graceMinutes ?? 10} 分钟`,
            ),
          ),
        ),
      );
    }

    function WarnToast({ state, busy, onAck, onOpen }) {
      return h(
        'div',
        {
          style: style({
            position: 'fixed',
            top: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 14px',
            borderRadius: 12,
            border: `1px solid ${COLORS.border}`,
            background: 'Canvas',
            color: 'CanvasText',
            boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
            pointerEvents: 'auto',
            fontSize: 12,
          }),
        },
        h('span', { style: { width: 8, height: 8, borderRadius: 999, background: COLORS.warn } }),
        h(
          'span',
          null,
          `今日 token 已用 ${percent(state)}%（${formatTokens(state.total)} / ${formatTokens(state.limit)}），注意预算。`,
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: onOpen,
            style: style({ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }),
          },
          '查看',
        ),
        h(
          'button',
          {
            type: 'button',
            disabled: busy,
            onClick: onAck,
            style: style({ border: 0, background: 'transparent', color: COLORS.muted, cursor: 'pointer' }),
          },
          '知道了',
        ),
      );
    }

    // ---- 根组件 ----
    function BudgetOverlay() {
      const { state, error, refresh } = useBudget();
      const [open, setOpen] = useState(false);
      const [modalClosed, setModalClosed] = useState(false);
      const [busy, setBusy] = useState(false);

      const over = Boolean(state?.over);
      const graceActive = Boolean(state?.graceActive);
      const stopped = Boolean(state?.stopped);

      // 额度重新可用时，让询问框重新出现。
      useEffect(() => {
        if (!over || graceActive || stopped) setModalClosed(false);
      }, [over, graceActive, stopped, state?.date]);

      const act = useCallback(
        async (kind, body) => {
          setBusy(true);
          try {
            const path = { continue: '/continue', stop: '/stop', reset: '/reset', config: '/config' }[kind];
            if (path) await post(path, body);
            await refresh();
            if (kind === 'continue' || kind === 'stop' || kind === 'reset') setModalClosed(true);
          } catch (cause) {
            console.warn(`[dsh-token-budget] ${kind} 失败:`, cause);
          } finally {
            setBusy(false);
          }
        },
        [refresh],
      );

      const ack = useCallback(async () => {
        setBusy(true);
        try {
          await post('/ack-warn', {});
          await refresh();
        } catch (cause) {
          console.warn('[dsh-token-budget] ack 失败:', cause);
        } finally {
          setBusy(false);
        }
      }, [refresh]);

      if (!state && !error) return null;

      const showModal = Boolean(state && over && !graceActive && !stopped && !modalClosed);
      const showToast = Boolean(state && state.warn && !state.ackWarn && !over);

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { style: { position: 'fixed', inset: 0, pointerEvents: 'none' } },
          h(
            'div',
            {
              style: {
                position: 'fixed',
                right: 20,
                bottom: 20,
                pointerEvents: 'auto',
                display: 'grid',
                justifyItems: 'end',
                gap: 8,
              },
            },
            open
              ? h(Panel, {
                  state,
                  error,
                  busy,
                  onAction: act,
                  onClose: () => setOpen(false),
                  onRefresh: refresh,
                })
              : null,
            h(Pill, { state, open, onToggle: () => setOpen((value) => !value) }),
          ),
          showToast
            ? h(WarnToast, {
                state,
                busy,
                onAck: ack,
                onOpen: () => {
                  setOpen(true);
                  void ack();
                },
              })
            : null,
          showModal
            ? h(OverModal, {
                state,
                busy,
                onAction: act,
                onClose: () => setModalClosed(true),
              })
            : null,
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-token-budget', order: 90 },
            BudgetOverlay,
          ),
        );
      },
    };
  },
});
