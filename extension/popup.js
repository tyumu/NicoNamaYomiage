(() => {
  'use strict';

  const WATCH_URL_RE = /^https:\/\/live\.nicovideo\.jp\/watch\//;

  const state = {
    activeTabId: null,
    isWatchTab: false,
    presets: [],
    masterControl: null,
    globals: null,
    tabState: null
  };

  const el = {
    connectBtn: document.getElementById('connectBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    bridgeDot: document.getElementById('bridgeDot'),
    bridgeStatusText: document.getElementById('bridgeStatusText'),
    editorDot: document.getElementById('editorDot'),
    editorStatusText: document.getElementById('editorStatusText'),
    queueText: document.getElementById('queueText'),
    tabNotice: document.getElementById('tabNotice'),
    tabSection: document.getElementById('tabSection'),
    tabEnabled: document.getElementById('tabEnabled'),
    tabEnabledLabel: document.getElementById('tabEnabledLabel'),
    tabVoicePreset: document.getElementById('tabVoicePreset'),
    tabOperatorPreset: document.getElementById('tabOperatorPreset'),
    tabVolume: document.getElementById('tabVolume'),
    tabVolumeVal: document.getElementById('tabVolumeVal'),
    resetVolumeBtn: document.getElementById('resetVolumeBtn'),
    tabSpeed: document.getElementById('tabSpeed'),
    tabSpeedVal: document.getElementById('tabSpeedVal'),
    resetSpeedBtn: document.getElementById('resetSpeedBtn'),
    stopBtn: document.getElementById('stopBtn'),
    clearTabBtn: document.getElementById('clearTabBtn'),
    globalAutoStart: document.getElementById('globalAutoStart'),
    globalDefaultPreset: document.getElementById('globalDefaultPreset'),
    globalOperatorPreset: document.getElementById('globalOperatorPreset'),
    globalReadGeneral: document.getElementById('globalReadGeneral'),
    globalReadOperator: document.getElementById('globalReadOperator'),
    globalReplaceUrl: document.getElementById('globalReplaceUrl'),
    globalMaxQueue: document.getElementById('globalMaxQueue'),
    globalMaxDelay: document.getElementById('globalMaxDelay'),
    globalBridgeUrl: document.getElementById('globalBridgeUrl'),
    saveGlobalBtn: document.getElementById('saveGlobalBtn'),
    feedback: document.getElementById('feedback')
  };

  let feedbackTimer = null;

  function showFeedback(text, kind = '') {
    el.feedback.textContent = text;
    el.feedback.className = `feedback ${kind ? `is-${kind}` : ''}`;
    clearTimeout(feedbackTimer);
    if (text) {
      feedbackTimer = setTimeout(() => {
        el.feedback.textContent = '';
        el.feedback.className = 'feedback';
      }, 2500);
    }
  }

  function setDot(dotEl, mode) {
    dotEl.classList.remove('dot-ok', 'dot-warn', 'dot-err');
    dotEl.classList.add(mode);
  }

  function renderHealth(health) {
    if (!health || !health.ok) {
      setDot(el.bridgeDot, 'dot-err');
      el.bridgeStatusText.textContent = 'ブリッジ: 未接続';
      setDot(el.editorDot, 'dot-err');
      el.editorStatusText.textContent = 'Editor: 不明';
      el.queueText.textContent = 'キュー: -';
      return;
    }

    setDot(el.bridgeDot, 'dot-ok');
    el.bridgeStatusText.textContent = `ブリッジ: 接続中 (${health.port || '-'})`;

    if (health.connected) {
      setDot(el.editorDot, 'dot-ok');
      el.editorStatusText.textContent = `Editor: ${health.hostStatus || '接続中'}`;
    } else {
      setDot(el.editorDot, 'dot-warn');
      el.editorStatusText.textContent = `Editor: 未接続 (${health.hostStatus || 'Disconnected'})`;
    }

    const qLen = typeof health.queueLength === 'number' ? health.queueLength : 0;
    el.queueText.textContent = `キュー: ${qLen}件`;
  }

  function fillSelect(selectEl, presets, selectedValue, defaultLabel) {
    selectEl.textContent = '';
    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = defaultLabel;
    selectEl.appendChild(defOpt);

    const list = Array.isArray(presets) ? [...presets] : [];
    if (selectedValue && !list.includes(selectedValue)) {
      list.push(selectedValue);
    }
    for (const name of list) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      selectEl.appendChild(opt);
    }
    selectEl.value = selectedValue || '';
  }

  function renderTabControls() {
    el.tabNotice.classList.toggle('hidden', state.isWatchTab);
    el.tabSection.classList.toggle('hidden', !state.isWatchTab);
    if (!state.isWatchTab || !state.tabState) return;

    const ts = state.tabState;
    el.tabEnabled.checked = Boolean(ts.enabled);
    el.tabEnabledLabel.textContent = ts.enabled ? 'ON' : 'OFF';

    const defGeneral = state.globals && state.globals.defaultVoicePreset
      ? `デフォルト (${state.globals.defaultVoicePreset})`
      : 'デフォルト (Editor現在値)';
    const defOperator = state.globals && state.globals.operatorVoicePreset
      ? `デフォルト (${state.globals.operatorVoicePreset})`
      : 'デフォルト (通常/Editor)';

    fillSelect(el.tabVoicePreset, state.presets, ts.voicePreset, defGeneral);
    fillSelect(el.tabOperatorPreset, state.presets, ts.operatorVoicePreset, defOperator);

    const mc = state.masterControl || {};
    const editorVol = typeof mc.Volume === 'number'
      ? mc.Volume
      : (typeof mc.volume === 'number' ? mc.volume : 1.0);
    if (typeof ts.volume === 'number') {
      el.tabVolume.value = String(ts.volume);
      el.tabVolume.classList.remove('is-default');
      el.tabVolumeVal.textContent = ts.volume.toFixed(2);
    } else {
      el.tabVolume.value = String(editorVol);
      el.tabVolume.classList.add('is-default');
      el.tabVolumeVal.textContent = 'Editorデフォルト';
    }

    const editorSpd = typeof mc.Speed === 'number'
      ? mc.Speed
      : (typeof mc.speed === 'number' ? mc.speed : 1.0);
    if (typeof ts.speed === 'number') {
      el.tabSpeed.value = String(ts.speed);
      el.tabSpeed.classList.remove('is-default');
      el.tabSpeedVal.textContent = ts.speed.toFixed(2);
    } else {
      el.tabSpeed.value = String(editorSpd);
      el.tabSpeed.classList.add('is-default');
      el.tabSpeedVal.textContent = 'Editorデフォルト';
    }
  }

  function renderGlobals() {
    const g = state.globals;
    if (!g) return;

    el.globalAutoStart.checked = Boolean(g.autoStart);
    fillSelect(el.globalDefaultPreset, state.presets, g.defaultVoicePreset, 'Editorの現在プリセット');
    fillSelect(el.globalOperatorPreset, state.presets, g.operatorVoicePreset, '通常プリセットと同じ');
    el.globalReadGeneral.checked = Boolean(g.readGeneral);
    el.globalReadOperator.checked = Boolean(g.readOperator);
    el.globalReplaceUrl.checked = Boolean(g.replaceUrl);
    el.globalMaxQueue.value = String(g.maxQueueSize);
    el.globalMaxDelay.value = String(g.maxDelaySeconds);
    el.globalBridgeUrl.value = g.bridgeUrl || 'http://127.0.0.1:50123';
  }

  async function updateCurrentTab(patch) {
    if (!state.isWatchTab || state.activeTabId === null) return;
    const res = await chrome.runtime.sendMessage({
      type: 'UPDATE_TAB_STATE',
      tabId: state.activeTabId,
      patch
    });
    if (res && res.ok) {
      state.tabState = res.tabState;
      renderTabControls();
    }
  }

  async function saveGlobalsPatch(patch, notifyMessage = '設定を保存しました') {
    const res = await chrome.runtime.sendMessage({
      type: 'SAVE_GLOBAL_SETTINGS',
      patch
    });
    if (res && res.ok) {
      state.globals = res.globals;
      renderGlobals();
      renderTabControls();
      if (patch.bridgeUrl !== undefined) {
        await loadAll();
      }
      showFeedback(notifyMessage, 'ok');
    } else {
      showFeedback((res && res.error) || '保存に失敗しました', 'error');
    }
  }

  async function loadAll() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    state.activeTabId = tab && typeof tab.id === 'number' ? tab.id : null;
    state.isWatchTab = Boolean(tab && typeof tab.url === 'string' && WATCH_URL_RE.test(tab.url));

    const res = await chrome.runtime.sendMessage({
      type: 'GET_INITIAL_DATA',
      tabId: state.isWatchTab ? state.activeTabId : undefined
    });

    if (!res || !res.ok) {
      showFeedback('状態の取得に失敗しました', 'error');
      return;
    }

    state.globals = res.globals;
    state.tabState = res.tabState;
    if (res.presets && res.presets.ok) {
      state.presets = Array.isArray(res.presets.presets) ? res.presets.presets : [];
      state.masterControl = res.presets.masterControl || null;
    } else {
      state.presets = [];
      state.masterControl = null;
    }

    renderHealth(res.health);
    renderGlobals();
    renderTabControls();
  }

  function bindEvents() {
    el.connectBtn.addEventListener('click', async () => {
      el.connectBtn.disabled = true;
      try {
        const res = await chrome.runtime.sendMessage({ type: 'BRIDGE_CONNECT' });
        if (res && res.presets && res.presets.ok) {
          state.presets = Array.isArray(res.presets.presets) ? res.presets.presets : [];
          state.masterControl = res.presets.masterControl || null;
        }
        renderHealth(res && res.health);
        renderGlobals();
        renderTabControls();
        if (res && res.ok && res.health && res.health.connected) {
          showFeedback('A.I.VOICE Editor に接続しました', 'ok');
        } else {
          showFeedback('A.I.VOICE 接続に失敗しました', 'error');
        }
      } finally {
        el.connectBtn.disabled = false;
      }
    });

    el.refreshBtn.addEventListener('click', async () => {
      await loadAll();
      showFeedback('状態を更新しました', 'ok');
    });

    el.tabEnabled.addEventListener('change', () => {
      updateCurrentTab({ enabled: el.tabEnabled.checked });
    });

    el.tabVoicePreset.addEventListener('change', () => {
      updateCurrentTab({ voicePreset: el.tabVoicePreset.value });
    });

    el.tabOperatorPreset.addEventListener('change', () => {
      updateCurrentTab({ operatorVoicePreset: el.tabOperatorPreset.value });
    });

    el.tabVolume.addEventListener('input', () => {
      const val = Number(el.tabVolume.value);
      el.tabVolume.classList.remove('is-default');
      el.tabVolumeVal.textContent = val.toFixed(2);
    });

    el.tabVolume.addEventListener('change', () => {
      updateCurrentTab({ volume: Number(el.tabVolume.value) });
    });

    el.resetVolumeBtn.addEventListener('click', () => {
      updateCurrentTab({ volume: null });
    });

    el.tabSpeed.addEventListener('input', () => {
      const val = Number(el.tabSpeed.value);
      el.tabSpeed.classList.remove('is-default');
      el.tabSpeedVal.textContent = val.toFixed(2);
    });

    el.tabSpeed.addEventListener('change', () => {
      updateCurrentTab({ speed: Number(el.tabSpeed.value) });
    });

    el.resetSpeedBtn.addEventListener('click', () => {
      updateCurrentTab({ speed: null });
    });

    el.stopBtn.addEventListener('click', async () => {
      const res = await chrome.runtime.sendMessage({ type: 'BRIDGE_STOP' });
      if (res && res.ok) {
        el.queueText.textContent = 'キュー: 0件';
        showFeedback('読み上げを停止しキューを消去しました', 'ok');
      } else {
        showFeedback('停止リクエストに失敗しました', 'error');
      }
    });

    el.clearTabBtn.addEventListener('click', async () => {
      if (state.activeTabId === null) return;
      const res = await chrome.runtime.sendMessage({
        type: 'BRIDGE_CLEAR',
        tabId: state.activeTabId,
        stopCurrent: true
      });
      if (res && res.ok) {
        showFeedback('このタブのキューを消去しました', 'ok');
      } else {
        showFeedback('キュー消去に失敗しました', 'error');
      }
    });

    el.globalAutoStart.addEventListener('change', () => {
      saveGlobalsPatch({ autoStart: el.globalAutoStart.checked });
    });

    el.globalDefaultPreset.addEventListener('change', () => {
      saveGlobalsPatch({ defaultVoicePreset: el.globalDefaultPreset.value });
    });

    el.globalOperatorPreset.addEventListener('change', () => {
      saveGlobalsPatch({ operatorVoicePreset: el.globalOperatorPreset.value });
    });

    el.globalReadGeneral.addEventListener('change', () => {
      saveGlobalsPatch({ readGeneral: el.globalReadGeneral.checked });
    });

    el.globalReadOperator.addEventListener('change', () => {
      saveGlobalsPatch({ readOperator: el.globalReadOperator.checked });
    });

    el.globalReplaceUrl.addEventListener('change', () => {
      saveGlobalsPatch({ replaceUrl: el.globalReplaceUrl.checked });
    });

    el.globalMaxQueue.addEventListener('change', () => {
      saveGlobalsPatch({ maxQueueSize: el.globalMaxQueue.value }, 'キュー設定を反映しました');
    });

    el.globalMaxDelay.addEventListener('change', () => {
      saveGlobalsPatch({ maxDelaySeconds: el.globalMaxDelay.value }, '遅延設定を反映しました');
    });

    el.saveGlobalBtn.addEventListener('click', () => {
      saveGlobalsPatch({
        bridgeUrl: el.globalBridgeUrl.value,
        maxQueueSize: el.globalMaxQueue.value,
        maxDelaySeconds: el.globalMaxDelay.value
      });
    });

    // Keep popup synced if on-page bar modifies the active tab state while popup is open.
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'session' || !state.isWatchTab || state.activeTabId === null) return;
      const key = `tab:${state.activeTabId}`;
      if (changes[key] && changes[key].newValue) {
        state.tabState = changes[key].newValue;
        renderTabControls();
      }
    });
  }

  bindEvents();
  loadAll().catch(() => {});
})();
