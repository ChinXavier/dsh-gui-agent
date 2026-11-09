/**
 * dsh-gui-agent client half.
 *
 * Adds one session-scoped control to the composer tool row
 * (conversation.input.left): the 「代理操作」 toggle, with the input-pace
 * dropdown (仿真 / 便捷 / 自定义) attached to it and only visible while the
 * mode is ON. All state lives on the host and is reached over the plugin's
 * own authenticated routes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-gui-agent',

  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ROUTE_BASE = '/gui-agent';

    const styles = {
      row: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
      root: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: '28px',
        padding: '0 10px',
        margin: '0 2px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.28))',
        background: 'transparent',
        color: 'var(--dsw-alias-text-secondary, inherit)',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '1',
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'background 120ms ease, border-color 120ms ease, color 120ms ease',
      },
      on: {
        background: 'rgba(47,124,246,0.12)',
        borderColor: 'rgba(47,124,246,0.45)',
        color: 'var(--dsw-alias-text-primary, inherit)',
      },
      busy: { opacity: 0.55, cursor: 'default' },
      dot: {
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: 'var(--dsw-alias-text-quaternary, rgba(127,127,127,0.7))',
        flex: '0 0 auto',
        transition: 'background 120ms ease, box-shadow 120ms ease',
      },
      dotOn: {
        background: 'var(--dsw-alias-accent, #2f7cf6)',
        boxShadow: '0 0 0 3px rgba(47,124,246,0.16)',
      },
      wrap: { position: 'relative', display: 'inline-flex' },
      caret: { fontSize: '9px', lineHeight: '1', opacity: 0.65, marginLeft: '1px' },
      menu: {
        position: 'absolute',
        bottom: 'calc(100% + 8px)',
        left: '0',
        minWidth: '184px',
        padding: '4px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.28))',
        background: 'var(--dsw-alias-bg-elevated, #ffffff)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
        display: 'grid',
        gap: '2px',
        zIndex: 30,
      },
      menuItem: {
        display: 'grid',
        gap: '2px',
        padding: '6px 8px',
        borderRadius: '7px',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-text-primary, inherit)',
        font: 'inherit',
        fontSize: '12px',
        textAlign: 'left',
        cursor: 'pointer',
      },
      menuItemActive: { background: 'rgba(47,124,246,0.12)' },
      menuHint: { fontSize: '10px', opacity: 0.62 },
      sliderRow: {
        display: 'grid',
        gap: '4px',
        padding: '6px 8px 8px',
        borderTop: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.22))',
        marginTop: '2px',
      },
      sliderLabel: { fontSize: '10px', opacity: 0.72, display: 'flex', justifyContent: 'space-between' },
      slider: { width: '100%', accentColor: '#2f7cf6' },
    };

    function texts(localeService) {
      let raw = '';
      try {
        if (localeService && typeof localeService.getLocale === 'function') {
          const value = localeService.getLocale();
          if (typeof value === 'string') raw = value;
          else if (value && typeof value === 'object') raw = String(value.locale || value.language || value.id || '');
        }
      } catch {
        /* fall back to Chinese */
      }
      const chinese = raw ? /^zh/i.test(raw) : true;
      if (chinese) {
        return {
          label: '代理操作',
          on: '本会话已开启代理操作，点击关闭',
          off: '为本会话开启代理操作（鼠标、键盘、截屏）',
          unknown: '无法读取代理操作状态',
          paceHuman: '仿真',
          paceFast: '便捷',
          paceCustom: '自定义',
          paceHint: '输入节奏：仿真 = 缓动轨迹与自然时序；便捷 = 瞬移与最短延时；自定义 = 调倍速',
          paceHumanHint: '两段贝塞尔轨迹、过冲回拉、对数正态按键、偶发打错重打',
          paceFastHint: '瞬移光标、固定快时序（做重复操作时更快）',
          paceCustomHint: '保持仿真路径，按倍数放慢/加快按键节奏',
          slowLabel: '节奏倍数',
          slowHint: '越小越快（0.2×），越大越慢（8×）',
        };
      }
      return {
        label: 'Agent control',
        on: 'Agent control is ON for this session — click to turn it off',
        off: 'Turn on agent control for this session (mouse, keyboard, screenshots)',
        unknown: 'Agent control state unavailable',
        paceHuman: 'Realistic',
        paceFast: 'Fast',
        paceCustom: 'Custom',
        paceHint: 'Input pace: realistic = eased paths and natural timing; fast = instant jumps; custom = slowdown multiplier',
        paceHumanHint: 'Two-segment Bezier path with overshoot, log-normal key timing, occasional typo+backspace',
        paceFastHint: 'Instant cursor, fixed fast timings (quicker for repeated work)',
        paceCustomHint: 'Keep the realistic path, scale the keystroke cadence',
        slowLabel: 'Speed factor',
        slowHint: 'Smaller is faster (0.2×), larger is slower (8×)',
      };
    }

    async function request(path, init, timeoutMs) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const response = await fetch(path, {
          credentials: 'same-origin',
          headers: { accept: 'application/json', ...(init && init.body ? { 'content-type': 'application/json' } : {}) },
          ...init,
          ...(controller ? { signal: controller.signal } : {}),
        });
        let payload = null;
        try {
          payload = await response.json();
        } catch {
          payload = null;
        }
        if (!response.ok) {
          const message = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
          throw new Error(message);
        }
        return payload || {};
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }

    function normalizePace(value) {
      return value === 'fast' || value === 'custom' ? value : 'human';
    }

    function normalizeSlowdown(value) {
      const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 1;
      return Math.min(8, Math.max(0.2, Math.round(numeric * 10) / 10));
    }

    function AgentControl(props) {
      const labels = texts(props.__localeService ?? null);
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';

      const [enabled, setEnabled] = React.useState(false);
      const [known, setKnown] = React.useState(false);
      const [pace, setPace] = React.useState('human');
      const [slowdown, setSlowdown] = React.useState(1);
      const [busy, setBusy] = React.useState(false);
      const [menuOpen, setMenuOpen] = React.useState(false);
      const [error, setError] = React.useState(null);
      const rootRef = React.useRef(null);
      const saveTimer = React.useRef(null);

      const applyState = (state) => {
        setEnabled(state.enabled === true);
        setPace(normalizePace(state.pace));
        setSlowdown(normalizeSlowdown(state.slowdown));
        setKnown(true);
        setError(null);
      };

      React.useEffect(() => {
        if (!sessionId) return undefined;
        let cancelled = false;
        request(`${ROUTE_BASE}/state?sessionId=${encodeURIComponent(sessionId)}`, undefined, 8000)
          .then((state) => {
            if (!cancelled) applyState(state);
          })
          .catch((cause) => {
            if (cancelled) return;
            setKnown(false);
            setError(cause && cause.message ? cause.message : String(cause));
          });
        return () => {
          cancelled = true;
        };
      }, [sessionId]);

      React.useEffect(() => {
        if (!menuOpen) return undefined;
        const onPointerDown = (event) => {
          const node = rootRef.current;
          if (node && event.target instanceof Node && node.contains(event.target)) return;
          setMenuOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
      }, [menuOpen]);

      React.useEffect(
        () => () => {
          if (saveTimer.current !== null) clearTimeout(saveTimer.current);
        },
        [],
      );

      const toggle = React.useCallback(() => {
        if (!sessionId || busy) return;
        const next = !enabled;
        setBusy(true);
        setEnabled(next);
        if (!next) setMenuOpen(false);
        request(`${ROUTE_BASE}/toggle`, { method: 'POST', body: JSON.stringify({ sessionId, enabled: next }) }, 10_000)
          .then(applyState)
          .catch((cause) => {
            setEnabled(!next);
            setError(cause && cause.message ? cause.message : String(cause));
          })
          .finally(() => setBusy(false));
      }, [busy, enabled, sessionId]);

      const choosePace = (next) => {
        if (!sessionId || next === pace) {
          if (next === 'custom') setMenuOpen(true);
          return;
        }
        const previous = pace;
        setPace(next);
        if (next !== 'custom') setMenuOpen(false);
        request(
          `${ROUTE_BASE}/pace`,
          { method: 'POST', body: JSON.stringify({ sessionId, pace: next, ...(next === 'custom' ? { slowdown } : {}) }) },
          10_000,
        )
          .then(applyState)
          .catch((cause) => {
            setPace(previous);
            setError(cause && cause.message ? cause.message : String(cause));
          });
      };

      const changeSlowdown = (raw) => {
        const next = normalizeSlowdown(Number(raw));
        setSlowdown(next);
        if (saveTimer.current !== null) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null;
          if (!sessionId) return;
          request(
            `${ROUTE_BASE}/pace`,
            { method: 'POST', body: JSON.stringify({ sessionId, pace: 'custom', slowdown: next }) },
            10_000,
          )
            .then(applyState)
            .catch((cause) => setError(cause && cause.message ? cause.message : String(cause)));
        }, 260);
      };

      const title = !sessionId
        ? labels.unknown
        : error
          ? `${labels.unknown}: ${error}`
          : enabled
            ? labels.on
            : labels.off;

      const paceLabel = pace === 'fast' ? labels.paceFast : pace === 'custom' ? labels.paceCustom : labels.paceHuman;

      const option = (value, text, hint) =>
        h(
          'button',
          {
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': pace === value,
            'data-gui-agent-pace-option': value,
            onClick: () => choosePace(value),
            style: { ...styles.menuItem, ...(pace === value ? styles.menuItemActive : null) },
          },
          h('span', { style: { fontWeight: pace === value ? '600' : '400' } }, text),
          h('span', { style: styles.menuHint }, hint),
        );

      const paceButton = h(
        'button',
        {
          type: 'button',
          className: 'dsh-gui-agent-pace',
          'data-gui-agent-pace': pace,
          'aria-haspopup': 'menu',
          'aria-expanded': menuOpen,
          title: labels.paceHint,
          onClick: () => setMenuOpen((value) => !value),
          style: { ...styles.root, ...(pace !== 'human' ? styles.on : null) },
        },
        h('span', { style: { whiteSpace: 'nowrap' } }, paceLabel),
        h('span', { 'aria-hidden': 'true', style: styles.caret }, '⌄'),
      );

      const slider =
        pace === 'custom'
          ? h(
              'div',
              { style: styles.sliderRow },
              h(
                'span',
                { style: styles.sliderLabel },
                h('span', null, labels.slowLabel),
                h('span', { 'data-gui-agent-slowdown-value': slowdown }, `${slowdown}×`),
              ),
              h('input', {
                type: 'range',
                min: 0.2,
                max: 8,
                step: 0.1,
                value: slowdown,
                'data-gui-agent-slowdown': 'slider',
                title: labels.slowHint,
                onChange: (event) => changeSlowdown(event.target.value),
                style: styles.slider,
              }),
            )
          : null;

      return h(
        'span',
        { ref: rootRef, style: styles.row },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-gui-agent-toggle',
            'data-gui-agent-toggle': enabled ? 'on' : 'off',
            'data-gui-agent-known': known ? 'yes' : 'no',
            'aria-pressed': enabled,
            title,
            disabled: busy || !sessionId,
            onClick: toggle,
            style: { ...styles.root, ...(enabled ? styles.on : null), ...(busy ? styles.busy : null) },
          },
          h('span', { 'aria-hidden': 'true', style: { ...styles.dot, ...(enabled ? styles.dotOn : null) } }),
          h('span', { style: { whiteSpace: 'nowrap' } }, labels.label),
        ),
        enabled
          ? h(
              'span',
              { style: styles.wrap },
              paceButton,
              menuOpen
                ? h(
                    'div',
                    { role: 'menu', 'data-gui-agent-menu': 'open', style: styles.menu },
                    option('human', labels.paceHuman, labels.paceHumanHint),
                    option('fast', labels.paceFast, labels.paceFastHint),
                    option('custom', labels.paceCustom, labels.paceCustomHint),
                    slider,
                  )
                : null,
            )
          : null,
      );
    }

    return {
      inject: ['slots'],

      apply(ctx) {
        const slots = (ctx && ctx.slots) || (typeof ctx.get === 'function' && ctx.get('slots')) || null;
        if (!slots || typeof slots.inject !== 'function') return;
        const localeService = typeof ctx.get === 'function' ? ctx.get('locale') : null;

        slots.inject('conversation.input.left', () =>
          slots.register(
            {
              name: 'conversation.input.left',
              id: 'gui-agent-toggle',
              order: 10,
              label: 'Agent control',
            },
            (props) => h(AgentControl, { ...props, __localeService: localeService }),
          ),
        );
      },
    };
  },
});
