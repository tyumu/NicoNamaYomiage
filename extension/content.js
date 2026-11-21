(() => {
  'use strict';

  if (window.__nicoliveYomiageContentLoaded) {
    return;
  }
  window.__nicoliveYomiageContentLoaded = true;

  const INJECT_SOURCE = 'nicolive-yomiage-inject';
  const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;

  const SYSTEM_SLASH_COMMANDS = new Set([
    'nicoad',
    'gift',
    'emotion',
    'spi',
    'trialpanel',
    'vote',
    'enquete',
    'disconnect',
    'clear',
    'cls',
    'commentlock',
    'commentmode',
    'reset',
    'hb',
    'uadpoint',
    'tag',
    'coe',
    'cruise',
    'jump',
    'redirect',
    'play',
    'stop',
    'ssng',
    'quote'
  ]);

  const SYSTEM_TEXT_PATTERNS = [
    /ニコニ広告/,
    /ギフトを贈りました/,
    /エモーション/,
    /プレミアム会員が.*登録/,
    /放送を開始しました/,
    /放送が終了しました/
  ];

  const COMMENT_LIST_SELECTORS = [
    '[data-testid="comment-list"]',
    '[class*="comment-list"]',
    '[class*="___comment-data-grid"]',
    '[class*="comment-panel"] [role="list"]',
    '[class*="comment-panel"] [role="grid"]',
    '[class*="comment-area"] [role="list"]'
  ];

  const COMMENT_ROW_SELECTORS = [
    '[data-testid="comment-item"]',
    '[class*="comment-item"]',
    '[class*="___comment-row"]',
    '[class*="___table-row"]',
    '[role="listitem"]',
    '[role="row"]'
  ];

  const COMMENT_BODY_SELECTORS = [
    '[data-testid="comment-text"]',
    '[class*="comment-text"]',
    '[class*="___comment-text"]',
    '[class*="comment-body"]',
    '[class*="___text"]'
  ];

  const IGNORED_SUBELEMENT_RE = /(?:name|author|user|number|index|time|date|badge|icon|label|rank|point)/i;

  const state = {
    tabId: null,
    globals: {
      readGeneral: true,
      readOperator: true,
      replaceUrl: true
    },
    tabState: {
      enabled: false,
      voicePreset: '',
      operatorVoicePreset: '',
      volume: null,
      speed: null
    },
    presets: [],
    health: null,
    activatedAt: Date.now(),
    domHydrationUntil: 0,
    collapsed: false
  };

  // Deduplication state
  const seenIds = new Map();
  const recentTexts = new Map();
  const seenDomNodes = new WeakSet();
  let observedContainer = null;
  let commentObserver = null;
  let containerScannerTimer = null;

  // Shadow UI references
  let uiHost = null;
  let uiElements = null;

  function pruneMap(map, ttlMs, maxSize) {
    const now = Date.now();
    for (const [k, ts] of map.entries()) {
      if (now - ts > ttlMs) {
        map.delete(k);
      }
    }
    while (map.size > maxSize) {
      const oldestKey = map.keys().next().value;
      map.delete(oldestKey);
    }
  }

  function decodeHtmlEntities(str) {
    return str
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }

  function formatCommentText(rawText, isOperator, replaceUrl) {
    if (typeof rawText !== 'string') return null;
    let text = rawText.trim();
    if (!text) return null;

    if (isOperator) {
      text = decodeHtmlEntities(text).trim();
      const cmdMatch = text.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
      if (cmdMatch) {
        const cmd = cmdMatch[1].toLowerCase();
        let rest = (cmdMatch[2] || '').trim();
        if (SYSTEM_SLASH_COMMANDS.has(cmd)) {
          return null;
        }
        if (cmd === 'telop') {
          if (/^(?:off|hide|clear)\b/i.test(rest)) {
            return null;
          }
          rest = rest.replace(/^show\s+/i, '');
        } else if (cmd === 'info') {
          rest = rest.replace(/^\d+\s+/, '');
        } else if (cmd === 'press') {
          rest = rest.replace(/^(?:show|white|red|green|blue|cyan|yellow|purple|pink|orange)\s+/i, '');
        }
        text = rest.trim();
      }
    } else if (text.startsWith('/')) {
      const cmdMatch = text.match(/^\/([a-zA-Z0-9_-]+)(?:\s|$)/);
      if (cmdMatch && SYSTEM_SLASH_COMMANDS.has(cmdMatch[1].toLowerCase())) {
        return null;
      }
    }

    if (!text) return null;

    if (replaceUrl) {
      text = text.replace(URL_RE, 'URL省略');
    }

    text = text.replace(/\s+/g, ' ').trim();
    return text || null;
  }

  function shouldAcceptComment(source, id, isOperator, formattedText) {
    const now = Date.now();
    pruneMap(seenIds, 60000, 500);
    pruneMap(recentTexts, 5000, 300);

    const textKey = `${isOperator ? 'op' : 'gen'}:${formattedText}`;

    if (id) {
      if (seenIds.has(id)) {
        return false;
      }
      seenIds.set(id, now);
      recentTexts.set(textKey, now);
      return true;
    }

    const prevTs = recentTexts.get(textKey);
    if (prevTs !== undefined && now - prevTs < (source === 'dom' ? 5000 : 3000)) {
      return false;
    }
    recentTexts.set(textKey, now);
    return true;
  }

  function recordBacklogComment(id, isOperator, formattedText) {
    const now = Date.now();
    if (id) {
      seenIds.set(id, now);
    }
    recentTexts.set(`${isOperator ? 'op' : 'gen'}:${formattedText}`, now);
  }

  function handleCapturedComment({ id, text, isOperator, timestampMs, source }) {
    if (!state.tabState.enabled) {
      return;
    }
    if (isOperator && !state.globals.readOperator) {
      return;
    }
    if (!isOperator && !state.globals.readGeneral) {
      return;
    }

    const formatted = formatCommentText(text, isOperator, state.globals.replaceUrl);
    if (!formatted) {
      return;
    }

    // Suppress backlog comments older than page load / activation.
    if (typeof timestampMs === 'number' && timestampMs < state.activatedAt - 2000) {
      recordBacklogComment(id, isOperator, formatted);
      return;
    }

    if (!shouldAcceptComment(source, id, isOperator, formatted)) {
      return;
    }

    chrome.runtime.sendMessage({
      type: 'SPEAK_COMMENT',
      payload: {
        text: formatted,
        isOperator: Boolean(isOperator),
        timestamp: typeof timestampMs === 'number' ? timestampMs : Date.now()
      }
    }).catch(() => {});
  }

  function isSystemDomNode(row) {
    const attrText = [
      row.className || '',
      row.getAttribute('data-comment-type') || '',
      row.getAttribute('data-type') || '',
      row.getAttribute('data-testid') || ''
    ].join(' ').toLowerCase();

    if (/(?:nicoad|gift|emotion|system|notify|advertisement|banner|trial|enquete)/.test(attrText)) {
      return true;
    }

    const raw = (row.textContent || '').trim();
    if (!raw) return true;
    for (const pattern of SYSTEM_TEXT_PATTERNS) {
      if (pattern.test(raw) && !row.querySelector(COMMENT_BODY_SELECTORS.join(','))) {
        return true;
      }
    }
    return false;
  }

  function isOperatorDomNode(row) {
    const attrText = [
      row.className || '',
      row.getAttribute('data-comment-type') || '',
      row.getAttribute('data-type') || '',
      row.getAttribute('data-is-operator') || ''
    ].join(' ').toLowerCase();
    return /(?:operator|broadcaster|official|owner)/.test(attrText) || row.getAttribute('data-is-operator') === 'true';
  }

  function extractDomBodyText(row) {
    for (const sel of COMMENT_BODY_SELECTORS) {
      const el = row.querySelector(sel);
      if (el && el.textContent) {
        return el.textContent;
      }
    }

    // Fallback: clone row and strip metadata sub-elements (username, comment number, timestamp).
    const clone = row.cloneNode(true);
    const descendants = clone.querySelectorAll('*');
    for (const child of descendants) {
      const cls = typeof child.className === 'string' ? child.className : '';
      const testId = child.getAttribute('data-testid') || '';
      const tag = child.tagName;
      if (tag === 'TIME' || IGNORED_SUBELEMENT_RE.test(cls) || IGNORED_SUBELEMENT_RE.test(testId)) {
        child.remove();
      }
    }
    return clone.textContent || '';
  }

  function findCommentRows(rootNode) {
    const rows = [];
    if (!(rootNode instanceof Element)) return rows;

    const combinedRowSelector = COMMENT_ROW_SELECTORS.join(',');
    if (rootNode.matches(combinedRowSelector)) {
      rows.push(rootNode);
      return rows;
    }
    const matched = rootNode.querySelectorAll(combinedRowSelector);
    if (matched.length > 0) {
      for (const el of matched) rows.push(el);
      return rows;
    }
    if (observedContainer && rootNode.parentElement === observedContainer) {
      rows.push(rootNode);
    }
    return rows;
  }

  function snapshotExistingDomComments(container) {
    if (!container) return;
    const combinedRowSelector = COMMENT_ROW_SELECTORS.join(',');
    const rows = container.querySelectorAll(combinedRowSelector);
    const targets = rows.length > 0 ? rows : container.children;

    for (const row of targets) {
      if (!(row instanceof Element)) continue;
      seenDomNodes.add(row);
      if (isSystemDomNode(row)) continue;
      const isOperator = isOperatorDomNode(row);
      const formatted = formatCommentText(extractDomBodyText(row), isOperator, state.globals.replaceUrl);
      if (formatted) {
        recordBacklogComment(null, isOperator, formatted);
      }
    }
  }

  function processDomRow(row, suppressAsBacklog) {
    if (!(row instanceof Element) || seenDomNodes.has(row)) {
      return;
    }
    seenDomNodes.add(row);
    if (isSystemDomNode(row)) {
      return;
    }

    const isOperator = isOperatorDomNode(row);
    const bodyText = extractDomBodyText(row);

    if (suppressAsBacklog) {
      const formatted = formatCommentText(bodyText, isOperator, state.globals.replaceUrl);
      if (formatted) {
        recordBacklogComment(null, isOperator, formatted);
      }
      return;
    }

    handleCapturedComment({
      id: null,
      text: bodyText,
      isOperator,
      timestampMs: Date.now(),
      source: 'dom'
    });
  }

  function findCommentContainer() {
    for (const sel of COMMENT_LIST_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function attachCommentObserver() {
    if (observedContainer && document.contains(observedContainer)) {
      return;
    }
    const container = findCommentContainer();
    if (!container) {
      return;
    }

    if (commentObserver) {
      commentObserver.disconnect();
    }

    observedContainer = container;
    state.domHydrationUntil = Date.now() + 1500;
    snapshotExistingDomComments(container);

    commentObserver = new MutationObserver((mutations) => {
      const suppressAsBacklog = Date.now() < state.domHydrationUntil;
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        for (const node of mutation.addedNodes) {
          const rows = findCommentRows(node);
          for (const row of rows) {
            processDomRow(row, suppressAsBacklog);
          }
        }
      }
    });

    commentObserver.observe(container, { childList: true, subtree: true });
  }

  function populateSelectOptions(selectEl, presets, selectedValue, defaultLabel) {
    if (!selectEl) return;
    selectEl.textContent = '';

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = defaultLabel;
    selectEl.appendChild(defaultOpt);

    const list = Array.isArray(presets) ? [...presets] : [];
    if (selectedValue && !list.includes(selectedValue)) {
      list.push(selectedValue);
    }
    for (const preset of list) {
      const opt = document.createElement('option');
      opt.value = preset;
      opt.textContent = preset;
      selectEl.appendChild(opt);
    }
    selectEl.value = selectedValue || '';
  }

  function renderOnPageBar() {
    if (!uiElements) return;

    const { toggleBtn, toggleText, generalSelect, operatorSelect, statusDot, controlsWrap, collapseBtn } = uiElements;
    const enabled = Boolean(state.tabState.enabled);

    toggleBtn.classList.toggle('is-on', enabled);
    toggleText.textContent = enabled ? '読み上げ ON' : '読み上げ OFF';

    const bridgeOk = Boolean(state.health && state.health.ok);
    const editorOk = Boolean(state.health && state.health.ok && state.health.connected);
    statusDot.classList.remove('is-ok', 'is-warn', 'is-err');
    if (editorOk) {
      statusDot.classList.add('is-ok');
      statusDot.title = `A.I.VOICE 接続中 (${state.health.hostStatus || 'Connected'})`;
    } else if (bridgeOk) {
      statusDot.classList.add('is-warn');
      statusDot.title = 'ブリッジ接続中 / A.I.VOICE 未接続';
    } else {
      statusDot.classList.add('is-err');
      statusDot.title = 'ブリッジ未接続';
    }

    populateSelectOptions(generalSelect, state.presets, state.tabState.voicePreset, '通常: デフォルト');
    populateSelectOptions(operatorSelect, state.presets, state.tabState.operatorVoicePreset, '運営: デフォルト');

    controlsWrap.classList.toggle('is-hidden', state.collapsed);
    collapseBtn.textContent = state.collapsed ? '▸' : '▾';
    collapseBtn.title = state.collapsed ? '展開' : '折りたたむ';
  }

  function makeDraggable(host, handle) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origLeft = 0;
    let origTop = 0;

    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      const rect = host.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      origLeft = rect.left;
      origTop = rect.top;
      host.style.left = `${origLeft}px`;
      host.style.top = `${origTop}px`;
      host.style.right = 'auto';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const maxLeft = Math.max(0, window.innerWidth - host.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - host.offsetHeight);
      host.style.left = `${Math.min(maxLeft, Math.max(0, origLeft + dx))}px`;
      host.style.top = `${Math.min(maxTop, Math.max(0, origTop + dy))}px`;
    });

    window.addEventListener('mouseup', () => {
      dragging = false;
    });
  }

  function mountOnPageBar() {
    if (uiHost || !document.body) return;

    uiHost = document.createElement('div');
    uiHost.id = 'nicolive-yomiage-bar-host';
    uiHost.style.cssText = 'position:fixed;top:60px;right:16px;z-index:2147483640;font-family:sans-serif;';

    const shadow = uiHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      .bar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(24, 24, 27, 0.88);
        backdrop-filter: blur(8px);
        border: 1px solid rgba(255, 255, 255, 0.16);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
        color: #f4f4f5;
        font-size: 12px;
        line-height: 1;
        user-select: none;
      }
      .drag-handle {
        cursor: grab;
        color: #a1a1aa;
        padding: 2px;
        font-size: 11px;
      }
      .drag-handle:active {
        cursor: grabbing;
      }
      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #ef4444;
        flex-shrink: 0;
      }
      .status-dot.is-ok { background: #22c55e; }
      .status-dot.is-warn { background: #f59e0b; }
      .status-dot.is-err { background: #ef4444; }
      .toggle-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: #27272a;
        color: #e4e4e7;
        border-radius: 999px;
        padding: 4px 9px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
      }
      .toggle-btn.is-on {
        background: #16a34a;
        border-color: #22c55e;
        color: #ffffff;
      }
      .controls {
        display: flex;
        align-items: center;
        gap: 5px;
      }
      .controls.is-hidden {
        display: none;
      }
      select {
        max-width: 118px;
        background: #27272a;
        color: #f4f4f5;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 6px;
        padding: 3px 5px;
        font-size: 11px;
        outline: none;
      }
      .icon-btn {
        background: transparent;
        border: none;
        color: #a1a1aa;
        cursor: pointer;
        padding: 2px 4px;
        font-size: 12px;
        border-radius: 4px;
      }
      .icon-btn:hover {
        color: #ffffff;
        background: rgba(255, 255, 255, 0.1);
      }
    `;

    const bar = document.createElement('div');
    bar.className = 'bar';

    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.textContent = '⋮⋮';
    dragHandle.title = 'ドラッグで移動';

    const statusDot = document.createElement('span');
    statusDot.className = 'status-dot';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'toggle-btn';
    const toggleText = document.createElement('span');
    toggleText.textContent = '読み上げ OFF';
    toggleBtn.appendChild(toggleText);

    const controlsWrap = document.createElement('div');
    controlsWrap.className = 'controls';

    const generalSelect = document.createElement('select');
    generalSelect.title = 'このタブの通常コメント声質';

    const operatorSelect = document.createElement('select');
    operatorSelect.title = 'このタブの運営コメント声質';

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'icon-btn';
    refreshBtn.textContent = '↻';
    refreshBtn.title = 'ブリッジ状態とプリセットを再読込';

    controlsWrap.append(generalSelect, operatorSelect, refreshBtn);

    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'icon-btn';
    collapseBtn.textContent = '▾';

    bar.append(dragHandle, statusDot, toggleBtn, controlsWrap, collapseBtn);
    shadow.append(style, bar);
    document.body.appendChild(uiHost);

    uiElements = {
      toggleBtn,
      toggleText,
      generalSelect,
      operatorSelect,
      statusDot,
      controlsWrap,
      collapseBtn
    };

    makeDraggable(uiHost, dragHandle);

    toggleBtn.addEventListener('click', () => {
      const nextEnabled = !state.tabState.enabled;
      applyTabState({ ...state.tabState, enabled: nextEnabled });
      chrome.runtime.sendMessage({
        type: 'UPDATE_TAB_STATE',
        patch: { enabled: nextEnabled }
      }).catch(() => {});
    });

    generalSelect.addEventListener('change', () => {
      const voicePreset = generalSelect.value;
      applyTabState({ ...state.tabState, voicePreset });
      chrome.runtime.sendMessage({
        type: 'UPDATE_TAB_STATE',
        patch: { voicePreset }
      }).catch(() => {});
    });

    operatorSelect.addEventListener('change', () => {
      const operatorVoicePreset = operatorSelect.value;
      applyTabState({ ...state.tabState, operatorVoicePreset });
      chrome.runtime.sendMessage({
        type: 'UPDATE_TAB_STATE',
        patch: { operatorVoicePreset }
      }).catch(() => {});
    });

    refreshBtn.addEventListener('click', () => {
      loadInitialState();
    });

    collapseBtn.addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      renderOnPageBar();
    });

    renderOnPageBar();
  }

  function applyTabState(nextTabState) {
    const wasEnabled = state.tabState.enabled;
    state.tabState = nextTabState;
    if (!wasEnabled && nextTabState.enabled) {
      state.activatedAt = Date.now();
      snapshotExistingDomComments(observedContainer);
    }
    renderOnPageBar();
  }

  async function loadInitialState() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_INITIAL_DATA' });
      if (!res || !res.ok) return;
      state.tabId = res.tabId;
      if (res.globals) state.globals = res.globals;
      if (res.health) state.health = res.health;
      if (res.presets && res.presets.ok && Array.isArray(res.presets.presets)) {
        state.presets = res.presets.presets;
      }
      if (res.tabState) {
        applyTabState(res.tabState);
      } else {
        renderOnPageBar();
      }
    } catch {
      // Service worker might be waking up.
    }
  }

  // Receive network-captured comments from MAIN world inject.js
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== INJECT_SOURCE || data.type !== 'COMMENT') {
      return;
    }
    handleCapturedComment(data.payload);
  });

  // Sync updates pushed from background.js / popup.js
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'TAB_STATE_UPDATED' && message.tabState) {
      applyTabState(message.tabState);
    } else if (message.type === 'GLOBALS_UPDATED' && message.globals) {
      state.globals = message.globals;
    } else if (message.type === 'PRESETS_UPDATED' && message.presets && Array.isArray(message.presets.presets)) {
      state.presets = message.presets.presets;
      renderOnPageBar();
    }
  });

  function startDomLifecycle() {
    mountOnPageBar();
    attachCommentObserver();
    if (!containerScannerTimer) {
      containerScannerTimer = setInterval(() => {
        mountOnPageBar();
        attachCommentObserver();
      }, 2000);
    }
  }

  loadInitialState();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startDomLifecycle, { once: true });
  } else {
    startDomLifecycle();
  }
})();
