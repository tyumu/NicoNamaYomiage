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

  const IGNORED_SUBELEMENT_RE = /(?:name|author|user|number|index|time|date|vpos|elapsed|badge|icon|label|rank|point|tooltip|popover|menu|action|control|meta)/i;
  const IGNORED_ROW_RE = /(?:tooltip|popover|context-menu|hover-menu)/i;

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
    activatedAt: Date.now(),
    domHydrationUntil: 0,
    networkActive: false
  };

  // Deduplication state
  const SEEN_ID_TTL_MS = 60 * 60 * 1000;
  const SEEN_ID_MAX = 5000;
  const DOM_HYDRATION_GRACE_MS = 2500;

  const seenIds = new Map();
  const recentTexts = new Map();
  const seenDomNodes = new WeakSet();
  let observedContainer = null;
  let commentObserver = null;
  let containerScannerTimer = null;
  let initialLoadRetryCount = 0;
  let contextInvalidated = false;

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

  function handleRuntimeError(err) {
    const msg = (err && err.message) || String(err || '');
    if (msg.includes('Extension context invalidated') && !contextInvalidated) {
      contextInvalidated = true;
      state.tabState.enabled = false;
      disableDomFallback();
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
    pruneMap(seenIds, SEEN_ID_TTL_MS, SEEN_ID_MAX);
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

  function disableDomFallback() {
    if (commentObserver) {
      commentObserver.disconnect();
      commentObserver = null;
    }
    if (containerScannerTimer) {
      clearInterval(containerScannerTimer);
      containerScannerTimer = null;
    }
    observedContainer = null;
  }

  function handleCapturedComment({ id, text, isOperator, timestampMs, source }) {
    if (source === 'network' && !state.networkActive) {
      state.networkActive = true;
      disableDomFallback();
    }
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
    }).catch(handleRuntimeError);
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

    // Fallback: clone row and strip metadata sub-elements (username, comment number, timestamp, buttons, tooltips).
    const clone = row.cloneNode(true);
    const descendants = clone.querySelectorAll('*');
    for (const child of descendants) {
      const cls = typeof child.className === 'string' ? child.className : '';
      const testId = child.getAttribute('data-testid') || '';
      const role = child.getAttribute('role') || '';
      const tag = child.tagName;
      if (
        tag === 'TIME' ||
        tag === 'BUTTON' ||
        role === 'button' ||
        role === 'tooltip' ||
        role === 'menu' ||
        IGNORED_SUBELEMENT_RE.test(cls) ||
        IGNORED_SUBELEMENT_RE.test(testId)
      ) {
        child.remove();
      }
    }
    return clone.textContent || '';
  }

  function findCommentRows(rootNode) {
    const rows = [];
    if (!(rootNode instanceof Element)) return rows;

    const rootRole = rootNode.getAttribute('role') || '';
    const rootCls = typeof rootNode.className === 'string' ? rootNode.className : '';
    if (rootRole === 'tooltip' || rootRole === 'menu' || IGNORED_ROW_RE.test(rootCls)) {
      return rows;
    }

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
    if (state.networkActive) {
      return;
    }
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
    state.domHydrationUntil = Math.max(state.domHydrationUntil, Date.now() + DOM_HYDRATION_GRACE_MS);
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

  function applyTabState(nextTabState) {
    const wasEnabled = state.tabState.enabled;
    state.tabState = nextTabState;
    if (!wasEnabled && nextTabState.enabled) {
      state.activatedAt = Date.now();
      snapshotExistingDomComments(observedContainer);
    }
  }

  async function loadInitialState() {
    if (contextInvalidated) return;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_INITIAL_DATA' });
      if (!res || !res.ok) return;
      initialLoadRetryCount = 0;
      state.tabId = res.tabId;
      if (res.globals) state.globals = res.globals;
      if (res.tabState) {
        applyTabState(res.tabState);
      }
    } catch (err) {
      handleRuntimeError(err);
      if (!contextInvalidated && initialLoadRetryCount < 3) {
        initialLoadRetryCount += 1;
        setTimeout(loadInitialState, 600 * initialLoadRetryCount);
      }
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
    }
  });

  function handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
      // Switching a background tab to the foreground causes React to flush deferred DOM comment rows.
      // Suppress DOM fallback mutations briefly while network capture continues uninterrupted.
      state.domHydrationUntil = Math.max(state.domHydrationUntil, Date.now() + DOM_HYDRATION_GRACE_MS);
      snapshotExistingDomComments(observedContainer);
    }
  }

  function startDomLifecycle() {
    if (state.networkActive || contextInvalidated) {
      return;
    }
    attachCommentObserver();
    if (!containerScannerTimer) {
      containerScannerTimer = setInterval(() => {
        if (state.networkActive || contextInvalidated) {
          disableDomFallback();
          return;
        }
        attachCommentObserver();
      }, 2000);
    }
  }

  document.addEventListener('visibilitychange', handleVisibilityChange);
  loadInitialState();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startDomLifecycle, { once: true });
  } else {
    startDomLifecycle();
  }
})();
