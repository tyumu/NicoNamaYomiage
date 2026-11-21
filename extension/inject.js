(() => {
  'use strict';

  if (window.__nicoliveYomiageInjected) {
    return;
  }
  window.__nicoliveYomiageInjected = true;

  const MESSAGE_SOURCE = 'nicolive-yomiage-inject';
  const textDecoder = new TextDecoder('utf-8', { fatal: true });

  const SKIP_EXTENSIONS_RE = /\.(?:ts|m4s|mp4|m3u8|aac|key|png|jpe?g|webp|gif|svg|woff2?|ttf|css|js)(?:[?#]|$)/i;
  const BACKWARD_SEGMENT_RE = /\/backward(?:[/?#]|$)|[?&]backward=/i;

  function emitComment(payload) {
    if (!payload || typeof payload.text !== 'string' || !payload.text) {
      return;
    }
    try {
      window.postMessage(
        {
          source: MESSAGE_SOURCE,
          type: 'COMMENT',
          payload
        },
        window.location.origin
      );
    } catch {
      // Ignore postMessage failures when frame is detaching.
    }
  }

  function decodeUtf8Strict(bytes) {
    try {
      const str = textDecoder.decode(bytes);
      // Reject control characters except newline/tab to avoid misinterpreting binary blobs.
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(str)) {
        return null;
      }
      return str;
    } catch {
      return null;
    }
  }

  function readVarint(buf, offset) {
    let result = 0;
    let shift = 0;
    let pos = offset;
    while (pos < buf.length && shift <= 49) {
      const byte = buf[pos++];
      result += (byte & 0x7f) * (2 ** shift);
      if ((byte & 0x80) === 0) {
        return { value: result, nextOffset: pos };
      }
      shift += 7;
    }
    return null;
  }

  function parseProtobufFields(buf) {
    const fields = [];
    let offset = 0;
    while (offset < buf.length) {
      const tag = readVarint(buf, offset);
      if (!tag || tag.value === 0) {
        return null;
      }
      offset = tag.nextOffset;
      const fieldNumber = Math.floor(tag.value / 8);
      const wireType = tag.value & 0x07;
      if (fieldNumber <= 0) {
        return null;
      }

      if (wireType === 0) {
        const val = readVarint(buf, offset);
        if (!val) return null;
        fields.push({ fieldNumber, wireType, value: val.value });
        offset = val.nextOffset;
      } else if (wireType === 1) {
        if (offset + 8 > buf.length) return null;
        fields.push({ fieldNumber, wireType, value: buf.subarray(offset, offset + 8) });
        offset += 8;
      } else if (wireType === 2) {
        const len = readVarint(buf, offset);
        if (!len || len.value < 0 || len.nextOffset + len.value > buf.length) {
          return null;
        }
        fields.push({
          fieldNumber,
          wireType,
          value: buf.subarray(len.nextOffset, len.nextOffset + len.value)
        });
        offset = len.nextOffset + len.value;
      } else if (wireType === 5) {
        if (offset + 4 > buf.length) return null;
        fields.push({ fieldNumber, wireType, value: buf.subarray(offset, offset + 4) });
        offset += 4;
      } else {
        // Unsupported/invalid wire type (3/4 deprecated groups or 6/7).
        return null;
      }
    }
    return fields;
  }

  function findField(fields, num, wireType) {
    if (!fields) return null;
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].fieldNumber === num && (wireType === undefined || fields[i].wireType === wireType)) {
        return fields[i].value;
      }
    }
    return null;
  }

  function parseTimestampMs(tsBytes) {
    const fields = parseProtobufFields(tsBytes);
    if (!fields) return null;
    const seconds = findField(fields, 1, 0);
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
      return null;
    }
    const nanos = findField(fields, 2, 0) || 0;
    return seconds * 1000 + Math.floor(nanos / 1e6);
  }

  function extractChatFromProto(chatBytes, metaId, timestampMs, isOperatorHint) {
    const chatFields = parseProtobufFields(chatBytes);
    if (!chatFields) return;
    const contentBytes = findField(chatFields, 1, 2);
    if (!contentBytes) return;
    const text = decodeUtf8Strict(contentBytes);
    if (!text) return;

    const no = findField(chatFields, 8, 0);
    const accountStatus = findField(chatFields, 4, 0);
    // In NDGR Chat, account_status 2 or premium flags may indicate operator in some contexts;
    // regular Chat is general viewer unless explicitly operator.
    const isOperator = Boolean(isOperatorHint) || accountStatus === 2;
    const id = metaId || (typeof no === 'number' ? `ndgr-no:${no}` : null);

    emitComment({
      id,
      text,
      isOperator,
      timestampMs: timestampMs || Date.now(),
      source: 'network'
    });
  }

  function processChunkedMessage(frameBytes) {
    const root = parseProtobufFields(frameBytes);
    if (!root) return;

    let metaId = null;
    let timestampMs = null;
    const metaBytes = findField(root, 1, 2);
    if (metaBytes) {
      const metaFields = parseProtobufFields(metaBytes);
      if (metaFields) {
        const idBytes = findField(metaFields, 1, 2);
        if (idBytes) {
          metaId = decodeUtf8Strict(idBytes);
        }
        const atBytes = findField(metaFields, 2, 2);
        if (atBytes) {
          timestampMs = parseTimestampMs(atBytes);
        }
      }
    }

    // Field 2: NicoliveMessage
    const messageBytes = findField(root, 2, 2);
    if (messageBytes) {
      const msgFields = parseProtobufFields(messageBytes);
      if (!msgFields) return;

      // Skip system notifications (simple_notification=2, gift=3, nicoad=4, etc.).
      const chatBytes = findField(msgFields, 1, 2) || findField(msgFields, 11, 2);
      if (chatBytes) {
        extractChatFromProto(chatBytes, metaId, timestampMs, false);
      }
      return;
    }

    // Field 4: NicoliveState -> Field 1: marquee -> Field 1: display -> Field 1: operator_comment
    const stateBytes = findField(root, 4, 2);
    if (stateBytes) {
      const stateFields = parseProtobufFields(stateBytes);
      const marqueeBytes = findField(stateFields, 1, 2);
      if (!marqueeBytes) return;
      const marqueeFields = parseProtobufFields(marqueeBytes);
      const displayBytes = findField(marqueeFields, 1, 2);
      if (!displayBytes) return;
      const displayFields = parseProtobufFields(displayBytes);
      const opBytes = findField(displayFields, 1, 2);
      if (!opBytes) return;
      const opFields = parseProtobufFields(opBytes);
      const contentBytes = findField(opFields, 1, 2);
      if (!contentBytes) return;
      const text = decodeUtf8Strict(contentBytes);
      if (text) {
        emitComment({
          id: metaId,
          text,
          isOperator: true,
          timestampMs: timestampMs || Date.now(),
          source: 'network'
        });
      }
    }
  }

  function processJsonPayload(rawText) {
    if (!rawText || typeof rawText !== 'string') return;
    const lines = rawText.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      handleJsonObject(parsed);
    }
  }

  function handleJsonObject(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const item of obj) handleJsonObject(item);
      return;
    }
    if (obj.chat && typeof obj.chat === 'object' && typeof obj.chat.content === 'string') {
      const chat = obj.chat;
      // In legacy Niconico chat JSON, premium === 2 or 3 indicates broadcaster/operator.
      const isOperator = chat.premium === 2 || chat.premium === 3;
      const ts = typeof chat.date === 'number' ? chat.date * 1000 : Date.now();
      const id = chat.no !== undefined ? `ws-no:${chat.no}:${chat.date || ''}` : null;
      emitComment({
        id,
        text: chat.content,
        isOperator,
        timestampMs: ts,
        source: 'network'
      });
      return;
    }
    if (obj.operatorComment && typeof obj.operatorComment.content === 'string') {
      emitComment({
        id: obj.id || null,
        text: obj.operatorComment.content,
        isOperator: true,
        timestampMs: Date.now(),
        source: 'network'
      });
    }
  }

  function shouldInspectFetch(urlStr, contentType) {
    if (!urlStr) return null;
    let parsed;
    try {
      parsed = new URL(urlStr, window.location.href);
    } catch {
      return null;
    }
    const host = parsed.hostname;
    if (host === '127.0.0.1' || host === 'localhost') {
      return null;
    }
    if (!host.endsWith('nicovideo.jp') && !host.endsWith('dmc.nico')) {
      return null;
    }
    if (SKIP_EXTENSIONS_RE.test(parsed.pathname)) {
      return null;
    }
    if (BACKWARD_SEGMENT_RE.test(parsed.href)) {
      return null;
    }

    const ct = (contentType || '').toLowerCase();
    const isCommentEndpoint = /\/(?:v\d+\/)?(?:segment|message|chunk|view|chat|comment)/i.test(parsed.pathname) ||
      host.startsWith('mpn.') || host.startsWith('msg.');

    if (!isCommentEndpoint) {
      return null;
    }
    if (ct.includes('protobuf') || ct.includes('octet-stream') || ct === '') {
      return 'protobuf';
    }
    if (ct.includes('json') || ct.includes('ndjson') || ct.includes('event-stream') || ct.includes('text/plain')) {
      return 'json';
    }
    return null;
  }

  async function consumeProtobufStream(stream) {
    const reader = stream.getReader();
    let buffer = new Uint8Array(0);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        const merged = new Uint8Array(buffer.length + value.byteLength);
        merged.set(buffer, 0);
        merged.set(value, buffer.length);
        buffer = merged;

        let offset = 0;
        while (offset < buffer.length) {
          const lenInfo = readVarint(buffer, offset);
          if (!lenInfo) break;
          if (lenInfo.value <= 0 || lenInfo.value > 1024 * 1024) {
            // Unexpected frame size; bail out safely to avoid buffering non-protobuf payloads.
            return;
          }
          if (lenInfo.nextOffset + lenInfo.value > buffer.length) {
            break;
          }
          const frame = buffer.subarray(lenInfo.nextOffset, lenInfo.nextOffset + lenInfo.value);
          processChunkedMessage(frame);
          offset = lenInfo.nextOffset + lenInfo.value;
        }
        if (offset > 0) {
          buffer = buffer.slice(offset);
        }
        if (buffer.length > 2 * 1024 * 1024) {
          return;
        }
      }
    } catch {
      // Stream aborted or closed cleanly.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Ignore.
      }
    }
  }

  async function consumeTextStream(stream) {
    const reader = stream.getReader();
    const streamDecoder = new TextDecoder('utf-8');
    let leftover = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        leftover += streamDecoder.decode(value, { stream: true });
        const lastNewline = leftover.lastIndexOf('\n');
        if (lastNewline !== -1) {
          processJsonPayload(leftover.slice(0, lastNewline));
          leftover = leftover.slice(lastNewline + 1);
        }
      }
      leftover += streamDecoder.decode();
      if (leftover.trim()) {
        processJsonPayload(leftover);
      }
    } catch {
      // Ignore stream cancellation.
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Ignore.
      }
    }
  }

  // Hook fetch()
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function patchedFetch(input, init) {
      const reqUrl = typeof input === 'string' ? input : (input && input.url) || '';
      const promise = origFetch.apply(this, arguments);
      promise.then((response) => {
        try {
          if (!response || !response.ok || !response.body) return;
          const mode = shouldInspectFetch(response.url || reqUrl, response.headers.get('content-type'));
          if (!mode) return;
          const clone = response.clone();
          if (mode === 'protobuf') {
            consumeProtobufStream(clone.body);
          } else {
            consumeTextStream(clone.body);
          }
        } catch {
          // Never break page fetch behavior.
        }
      }).catch(() => {});
      return promise;
    };
  }

  // Hook WebSocket
  const OrigWebSocket = window.WebSocket;
  if (typeof OrigWebSocket === 'function') {
    class PatchedWebSocket extends OrigWebSocket {
      constructor(url, protocols) {
        if (protocols !== undefined) {
          super(url, protocols);
        } else {
          super(url);
        }
        this.addEventListener('message', (event) => {
          try {
            if (typeof event.data === 'string') {
              processJsonPayload(event.data);
            }
          } catch {
            // Never interfere with page WebSocket handlers.
          }
        });
      }
    }
    window.WebSocket = PatchedWebSocket;
  }
})();
