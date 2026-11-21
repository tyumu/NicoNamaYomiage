'use strict';

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:50123';
const NATIVE_HOST_NAME = 'com.niconama.aivoice_bridge';

const DEFAULT_GLOBAL_SETTINGS = {
  bridgeUrl: DEFAULT_BRIDGE_URL,
  autoStart: false,
  defaultVoicePreset: '',
  operatorVoicePreset: '',
  readGeneral: true,
  readOperator: true,
  replaceUrl: true,
  volume: null,
  speed: null,
  maxQueueSize: 5,
  maxDelaySeconds: 10
};

const TAB_KEY_PREFIX = 'tab:';
const BRIDGE_TIMEOUT_MS = 4000;
const LAUNCH_POLL_TIMEOUT_MS = 60000;

let activeLaunchId = 0;
let activeLaunchUntil = 0;

function tabStorageKey(tabId) {
  return `${TAB_KEY_PREFIX}${tabId}`;
}

function isWatchUrl(url) {
  return typeof url === 'string' && /^https:\/\/live\.nicovideo\.jp\/watch\//.test(url);
}

function normalizeBridgeUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return DEFAULT_BRIDGE_URL;
  }
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return DEFAULT_BRIDGE_URL;
    }
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      return DEFAULT_BRIDGE_URL;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return DEFAULT_BRIDGE_URL;
  }
}

function sanitizeNumberOrNull(val, min, max) {
  if (val === null || val === undefined || val === '') {
    return null;
  }
  const num = Number(val);
  if (!Number.isFinite(num)) {
    return null;
  }
  return Math.min(max, Math.max(min, num));
}

function sanitizeInt(val, fallback, min, max) {
  const num = Number.parseInt(val, 10);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, num));
}

async function getGlobalSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_GLOBAL_SETTINGS);
  return {
    bridgeUrl: normalizeBridgeUrl(stored.bridgeUrl),
    autoStart: Boolean(stored.autoStart),
    defaultVoicePreset: typeof stored.defaultVoicePreset === 'string' ? stored.defaultVoicePreset : '',
    operatorVoicePreset: typeof stored.operatorVoicePreset === 'string' ? stored.operatorVoicePreset : '',
    readGeneral: stored.readGeneral !== false,
    readOperator: stored.readOperator !== false,
    replaceUrl: stored.replaceUrl !== false,
    volume: sanitizeNumberOrNull(stored.volume, 0, 2),
    speed: sanitizeNumberOrNull(stored.speed, 0.5, 4),
    maxQueueSize: sanitizeInt(stored.maxQueueSize, DEFAULT_GLOBAL_SETTINGS.maxQueueSize, 1, 100),
    maxDelaySeconds: sanitizeInt(stored.maxDelaySeconds, DEFAULT_GLOBAL_SETTINGS.maxDelaySeconds, 1, 300)
  };
}

async function saveGlobalSettings(patch) {
  const current = await getGlobalSettings();
  const next = {
    ...current,
    ...(patch.bridgeUrl !== undefined ? { bridgeUrl: normalizeBridgeUrl(patch.bridgeUrl) } : {}),
    ...(patch.autoStart !== undefined ? { autoStart: Boolean(patch.autoStart) } : {}),
    ...(patch.defaultVoicePreset !== undefined
      ? { defaultVoicePreset: typeof patch.defaultVoicePreset === 'string' ? patch.defaultVoicePreset : '' }
      : {}),
    ...(patch.operatorVoicePreset !== undefined
      ? { operatorVoicePreset: typeof patch.operatorVoicePreset === 'string' ? patch.operatorVoicePreset : '' }
      : {}),
    ...(patch.readGeneral !== undefined ? { readGeneral: Boolean(patch.readGeneral) } : {}),
    ...(patch.readOperator !== undefined ? { readOperator: Boolean(patch.readOperator) } : {}),
    ...(patch.replaceUrl !== undefined ? { replaceUrl: Boolean(patch.replaceUrl) } : {}),
    ...(patch.volume !== undefined ? { volume: sanitizeNumberOrNull(patch.volume, 0, 2) } : {}),
    ...(patch.speed !== undefined ? { speed: sanitizeNumberOrNull(patch.speed, 0.5, 4) } : {}),
    ...(patch.maxQueueSize !== undefined ? { maxQueueSize: sanitizeInt(patch.maxQueueSize, current.maxQueueSize, 1, 100) } : {}),
    ...(patch.maxDelaySeconds !== undefined ? { maxDelaySeconds: sanitizeInt(patch.maxDelaySeconds, current.maxDelaySeconds, 1, 300) } : {})
  };
  await chrome.storage.local.set(next);
  return next;
}

async function getTabState(tabId) {
  const key = tabStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  if (stored[key]) {
    return stored[key];
  }
  const globals = await getGlobalSettings();
  const initial = {
    enabled: globals.autoStart,
    voicePreset: globals.defaultVoicePreset || '',
    operatorVoicePreset: globals.operatorVoicePreset || '',
    volume: globals.volume,
    speed: globals.speed
  };
  await chrome.storage.session.set({ [key]: initial });
  await updateTabBadge(tabId, initial.enabled);
  return initial;
}

async function updateTabState(tabId, patch) {
  const current = await getTabState(tabId);
  const next = {
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled,
    voicePreset: patch.voicePreset !== undefined
      ? (typeof patch.voicePreset === 'string' ? patch.voicePreset : '')
      : current.voicePreset,
    operatorVoicePreset: patch.operatorVoicePreset !== undefined
      ? (typeof patch.operatorVoicePreset === 'string' ? patch.operatorVoicePreset : '')
      : current.operatorVoicePreset,
    volume: patch.volume !== undefined ? sanitizeNumberOrNull(patch.volume, 0, 2) : current.volume,
    speed: patch.speed !== undefined ? sanitizeNumberOrNull(patch.speed, 0.5, 4) : current.speed
  };
  await chrome.storage.session.set({ [tabStorageKey(tabId)]: next });
  await updateTabBadge(tabId, next.enabled);

  // Turning reading off for a tab immediately clears queued items for that tab.
  if (current.enabled && !next.enabled) {
    bridgeRequest('/clear', 'POST', { tabId, stopCurrent: true }).catch(() => {});
  }

  notifyTab(tabId, { type: 'TAB_STATE_UPDATED', tabId, tabState: next });
  return next;
}

async function updateTabBadge(tabId, enabled) {
  try {
    await chrome.action.setBadgeText({ tabId, text: enabled ? 'ON' : '' });
    if (enabled) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#16a34a' });
    }
  } catch {
    // Tab may already be closed.
  }
}

function notifyTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

async function notifyAllWatchTabs(message) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://live.nicovideo.jp/watch/*' });
    for (const tab of tabs) {
      if (typeof tab.id === 'number') {
        notifyTab(tab.id, message);
      }
    }
  } catch {
    // Ignore query errors.
  }
}

async function bridgeRequest(path, method = 'GET', body = undefined, overrideBaseUrl = null) {
  const globals = await getGlobalSettings();
  const baseUrl = overrideBaseUrl ? normalizeBridgeUrl(overrideBaseUrl) : globals.bridgeUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);

  try {
    const options = {
      method,
      signal: controller.signal,
      headers: {}
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl}${path}`, options);
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: (data && data.error) || `HTTP ${response.status}`,
        data
      };
    }
    return data && typeof data === 'object' ? { ok: true, ...data } : { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: err && err.name === 'AbortError' ? 'タイムアウト' : (err && err.message) || 'ブリッジに接続できません'
    };
  } finally {
    clearTimeout(timer);
  }
}

async function syncBridgeConfig(globals) {
  return bridgeRequest('/config', 'POST', {
    maxQueueSize: globals.maxQueueSize,
    maxDelaySeconds: globals.maxDelaySeconds
  }, globals.bridgeUrl);
}

function startBackgroundLaunchPolling(baseUrl) {
  const launchId = ++activeLaunchId;
  const deadline = Date.now() + LAUNCH_POLL_TIMEOUT_MS;
  activeLaunchUntil = deadline;

  (async () => {
    let configSynced = false;
    let attempt = 0;

    while (launchId === activeLaunchId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      if (launchId !== activeLaunchId) break;

      const globals = await getGlobalSettings();
      const targetUrl = baseUrl || globals.bridgeUrl;
      let health = await bridgeRequest('/health', 'GET', undefined, targetUrl);

      if (health && health.ok && !configSynced) {
        configSynced = true;
        syncBridgeConfig(globals).catch(() => {});
      }

      if (health && health.ok && !health.connected && attempt % 3 === 0) {
        const connectRes = await bridgeRequest('/connect', 'POST', {}, targetUrl);
        if (connectRes && connectRes.ok) {
          health = await bridgeRequest('/health', 'GET', undefined, targetUrl);
        }
      }
      attempt += 1;

      if (health && health.ok && health.connected) {
        const presets = await bridgeRequest('/presets', 'GET', undefined, targetUrl);
        if (presets && presets.ok) {
          notifyAllWatchTabs({ type: 'PRESETS_UPDATED', presets });
        }
        break;
      }
    }

    if (launchId === activeLaunchId) {
      activeLaunchUntil = 0;
    }
  })().catch(() => {
    if (launchId === activeLaunchId) {
      activeLaunchUntil = 0;
    }
  });
}

async function handleSpeakComment(tabId, payload) {
  if (typeof tabId !== 'number' || !payload || typeof payload.text !== 'string') {
    return { ok: false, skipped: true };
  }

  const text = payload.text.trim();
  if (!text) {
    return { ok: false, skipped: true };
  }

  const [globals, tabState] = await Promise.all([
    getGlobalSettings(),
    getTabState(tabId)
  ]);

  if (!tabState.enabled) {
    return { ok: false, skipped: true, reason: 'disabled' };
  }

  const isOperator = Boolean(payload.isOperator);
  if (isOperator && !globals.readOperator) {
    return { ok: false, skipped: true, reason: 'operator_disabled' };
  }
  if (!isOperator && !globals.readGeneral) {
    return { ok: false, skipped: true, reason: 'general_disabled' };
  }

  const voicePreset = isOperator
    ? (tabState.operatorVoicePreset || globals.operatorVoicePreset || tabState.voicePreset || globals.defaultVoicePreset || '')
    : (tabState.voicePreset || globals.defaultVoicePreset || '');

  const speakBody = {
    tabId,
    text,
    timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
    isOperator
  };

  if (voicePreset) {
    speakBody.voicePreset = voicePreset;
  }

  const effectiveVolume = typeof tabState.volume === 'number' ? tabState.volume : globals.volume;
  const effectiveSpeed = typeof tabState.speed === 'number' ? tabState.speed : globals.speed;

  if (typeof effectiveVolume === 'number') {
    speakBody.volume = effectiveVolume;
  }
  if (typeof effectiveSpeed === 'number') {
    speakBody.speed = effectiveSpeed;
  }

  return bridgeRequest('/speak', 'POST', speakBody, globals.bridgeUrl);
}

async function cleanupTab(tabId) {
  const key = tabStorageKey(tabId);
  const existing = await chrome.storage.session.get(key);
  if (!existing[key]) {
    return;
  }
  await chrome.storage.session.remove(key);
  await updateTabBadge(tabId, false);
  await bridgeRequest('/clear', 'POST', { tabId, stopCurrent: true });
}

chrome.runtime.onInstalled.addListener(async () => {
  const globals = await getGlobalSettings();
  await chrome.storage.local.set(globals);
  syncBridgeConfig(globals).catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  const globals = await getGlobalSettings();
  syncBridgeConfig(globals).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cleanupTab(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) {
    return;
  }
  if (!isWatchUrl(changeInfo.url)) {
    cleanupTab(tabId).catch(() => {});
    return;
  }
  // Navigating to a different broadcast on the same tab clears queued items from the prior broadcast.
  chrome.storage.session.get(tabStorageKey(tabId)).then((stored) => {
    if (stored[tabStorageKey(tabId)]) {
      bridgeRequest('/clear', 'POST', { tabId }).catch(() => {});
    }
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || typeof message.type !== 'string') {
      sendResponse({ ok: false, error: 'Invalid message' });
      return;
    }

    const senderTabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;

    switch (message.type) {
      case 'GET_INITIAL_DATA': {
        const targetTabId = typeof message.tabId === 'number' ? message.tabId : senderTabId;
        const globals = await getGlobalSettings();
        const tabState = targetTabId !== null ? await getTabState(targetTabId) : null;
        const [health, presets] = await Promise.all([
          bridgeRequest('/health', 'GET', undefined, globals.bridgeUrl),
          bridgeRequest('/presets', 'GET', undefined, globals.bridgeUrl)
        ]);
        sendResponse({
          ok: true,
          tabId: targetTabId,
          globals,
          tabState,
          health,
          presets,
          launchPollingRemainingMs: Math.max(0, activeLaunchUntil - Date.now())
        });
        return;
      }

      case 'GET_TAB_STATE': {
        const targetTabId = typeof message.tabId === 'number' ? message.tabId : senderTabId;
        if (targetTabId === null) {
          sendResponse({ ok: false, error: 'Missing tabId' });
          return;
        }
        const [globals, tabState] = await Promise.all([
          getGlobalSettings(),
          getTabState(targetTabId)
        ]);
        sendResponse({ ok: true, tabId: targetTabId, globals, tabState });
        return;
      }

      case 'UPDATE_TAB_STATE': {
        const targetTabId = typeof message.tabId === 'number' ? message.tabId : senderTabId;
        if (targetTabId === null) {
          sendResponse({ ok: false, error: 'Missing tabId' });
          return;
        }
        const tabState = await updateTabState(targetTabId, message.patch || {});
        sendResponse({ ok: true, tabId: targetTabId, tabState });
        return;
      }

      case 'GET_GLOBAL_SETTINGS': {
        const globals = await getGlobalSettings();
        sendResponse({ ok: true, globals });
        return;
      }

      case 'SAVE_GLOBAL_SETTINGS': {
        const globals = await saveGlobalSettings(message.patch || {});
        const configResult = await syncBridgeConfig(globals);
        await notifyAllWatchTabs({ type: 'GLOBALS_UPDATED', globals });
        sendResponse({ ok: true, globals, configResult });
        return;
      }

      case 'BRIDGE_HEALTH': {
        const health = await bridgeRequest('/health', 'GET');
        sendResponse(health);
        return;
      }

      case 'BRIDGE_PRESETS': {
        const presets = await bridgeRequest('/presets', 'GET');
        if (presets.ok) {
          notifyAllWatchTabs({ type: 'PRESETS_UPDATED', presets });
        }
        sendResponse(presets);
        return;
      }

      case 'BRIDGE_CONNECT': {
        const connectRes = await bridgeRequest('/connect', 'POST', {});
        const globals = await getGlobalSettings();
        if (connectRes.ok) {
          await syncBridgeConfig(globals);
        }
        const [health, presets] = await Promise.all([
          bridgeRequest('/health', 'GET', undefined, globals.bridgeUrl),
          bridgeRequest('/presets', 'GET', undefined, globals.bridgeUrl)
        ]);
        if (presets.ok) {
          notifyAllWatchTabs({ type: 'PRESETS_UPDATED', presets });
        }
        sendResponse({
          ok: Boolean(connectRes.ok),
          connect: connectRes,
          health,
          presets
        });
        return;
      }

      case 'BRIDGE_LAUNCH': {
        let nativeRes;
        try {
          nativeRes = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
            action: 'start',
            launchEditor: true
          });
        } catch (err) {
          const msg = (err && err.message) || String(err || '');
          const notRegistered = /not found|forbidden|access|specified native messaging host/i.test(msg);
          sendResponse({
            ok: false,
            notRegistered,
            error: notRegistered
              ? 'Native Host が未登録です。register-native-host.bat を1回実行してください。'
              : msg
          });
          return;
        }

        if (!nativeRes || !nativeRes.ok) {
          sendResponse({
            ok: false,
            error: (nativeRes && nativeRes.error) || '起動に失敗しました'
          });
          return;
        }

        const globals = await getGlobalSettings();
        let health = null;
        // Wait briefly for bridge HTTP server to respond, then continue polling up to 60s.
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 400));
          health = await bridgeRequest('/health', 'GET', undefined, globals.bridgeUrl);
          if (health && health.ok) {
            await syncBridgeConfig(globals);
            if (!health.connected) {
              await bridgeRequest('/connect', 'POST', {}, globals.bridgeUrl);
              health = await bridgeRequest('/health', 'GET', undefined, globals.bridgeUrl);
            }
            break;
          }
        }

        let presets = null;
        if (health && health.ok && health.connected) {
          presets = await bridgeRequest('/presets', 'GET', undefined, globals.bridgeUrl);
          if (presets && presets.ok) {
            notifyAllWatchTabs({ type: 'PRESETS_UPDATED', presets });
          }
        } else {
          startBackgroundLaunchPolling(globals.bridgeUrl);
        }

        sendResponse({
          ok: true,
          native: nativeRes,
          health,
          presets,
          polling: !(health && health.ok && health.connected),
          timeoutMs: LAUNCH_POLL_TIMEOUT_MS
        });
        return;
      }

      case 'BRIDGE_STOP': {
        const res = await bridgeRequest('/stop', 'POST', {});
        sendResponse(res);
        return;
      }

      case 'BRIDGE_CLEAR': {
        const body = {};
        if (typeof message.tabId === 'number') {
          body.tabId = message.tabId;
        }
        if (typeof message.stopCurrent === 'boolean') {
          body.stopCurrent = message.stopCurrent;
        }
        const res = await bridgeRequest('/clear', 'POST', body);
        sendResponse(res);
        return;
      }

      case 'SPEAK_COMMENT': {
        const res = await handleSpeakComment(senderTabId, message.payload);
        sendResponse(res);
        return;
      }

      default:
        sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: (err && err.message) || 'Internal error' });
  });

  return true;
});
