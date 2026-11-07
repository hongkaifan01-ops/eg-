// MAIN world：在抖音页面里旁路监听接口响应，抓播放地址
(() => {
  if (window.__egaiHooked) return;
  window.__egaiHooked = true;

  const MAX = 40;
  const media = new Set();
  const meta = { title: '', author: '', duration: 0, cover: '', desc: '', size: 0 };

  const push = (u) => {
    if (!u || typeof u !== 'string') return;
    if (!/^https?:\/\//i.test(u)) return;
    if (!/\.mp4|mime_type=video|video\/tos|aweme\.snssdk|douyinvod|v\d+-web|playwm|\/play\//i.test(u)) return;
    if (media.size >= MAX) return;
    media.add(u);
  };

  const walk = (node, depth = 0) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    if (typeof node.desc === 'string' && !meta.desc) meta.desc = node.desc;
    if (typeof node.title === 'string' && !meta.title && node.title.length < 200) meta.title = node.title;
    if (node.author && typeof node.author.nickname === 'string' && !meta.author) meta.author = node.author.nickname;
    if (node.video && typeof node.video === 'object') {
      const v = node.video;
      if (v.duration && !meta.duration) meta.duration = Number(v.duration) / (Number(v.duration) > 3000 ? 1000 : 1);
      for (const key of ['play_addr', 'play_addr_h264', 'play_addr_265', 'download_addr', 'play_addr_lowbr']) {
        const list = v[key]?.url_list;
        if (Array.isArray(list)) list.forEach(push);
      }
      for (const br of v.bit_rate || []) {
        (br.play_addr?.url_list || []).forEach(push);
      }
      if (v.cover?.url_list?.[0] && !meta.cover) meta.cover = v.cover.url_list[0];
      if (v.play_addr?.data_size && !meta.size) meta.size = Number(v.play_addr.data_size);
    }
    for (const k of Object.keys(node)) {
      if (k === 'author' || k === 'video' || k === 'stats' || k === 'music') continue;
      const v = node[k];
      if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };

  const parseBody = (text, url) => {
    if (!text || text.length > 4_000_000) return;
    if (!/play_addr|playAddr|url_list|\.mp4/.test(text)) return;
    try {
      const j = JSON.parse(text);
      walk(j);
      post();
    } catch {
      const urls = text.match(/https?:\\?\/\\?\/[^"'\s\\]+(?:\.mp4|mime_type=video)[^"'\s\\]*/g) || [];
      urls.forEach((u) => push(u.replace(/\\\//g, '/')));
      post();
    }
  };

  let lastPost = 0;
  const post = (force = false) => {
    const now = Date.now();
    if (!force && now - lastPost < 500) return;
    lastPost = now;
    window.postMessage({ __egai: true, kind: 'douyin-media', mediaUrls: [...media], meta }, '*');
  };

  // 1) 劫持 fetch
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        p.then((res) => {
          const type = res.headers?.get?.('content-type') || '';
          if (type.includes('json') || /aweme|iteminfo|detail/i.test(url)) {
            res.clone().text().then((t) => parseBody(t, url)).catch(() => {});
          }
        }).catch(() => {});
      } catch {}
      return p;
    };
  }

  // 2) 劫持 XHR
  const OrigOpen = XMLHttpRequest.prototype.open;
  const OrigSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__egaiUrl = url;
    return OrigOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        const text = this.responseType === '' || this.responseType === 'text' ? this.responseText : '';
        if (text) parseBody(text, this.__egaiUrl || '');
      } catch {}
    });
    return OrigSend.apply(this, args);
  };

  // 3) 兜底：直接读 video 元素 / 资源时序
  const scanFallback = () => {
    document.querySelectorAll('video').forEach((v) => {
      push(v.currentSrc || v.src || '');
    });
    try {
      for (const e of performance.getEntriesByType('resource')) {
        push(e.name);
      }
    } catch {}
  };

  // 4) 页面自渲染后持续上报 30 秒
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    scanFallback();
    post(true);
    if (ticks > 18) clearInterval(timer);
  }, 1600);
  window.addEventListener('load', () => {
    scanFallback();
    post(true);
  });
  document.addEventListener('DOMContentLoaded', () => {
    scanFallback();
    post(true);
  });

  // 5) 回应隔离世界的查询
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__egaiQuery !== true) return;
    window.postMessage({ __egai: true, kind: 'douyin-media', mediaUrls: [...media], meta, replyTo: ev.data.id }, '*');
  });
})();
