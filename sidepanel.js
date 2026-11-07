// 侧边栏交互：检索 / 翻译 / 总结 / 下载
import { escapeHtml, extractUrls, isEnglishText, truncate, formatBytes, formatDuration } from './lib/util.js';

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const sendBtn = $('btn-send');

let settings = {};
let aiOn = false;
let busy = false;
let readReplies = true;
const chatHistory = [];
async function readReply(text) {
  try {await call('reply.speak',{text});}catch(error){toast('朗读失败：'+error.message);}
}
$('reply-audio').onclick=async()=>{
  readReplies=!readReplies;$('reply-audio').textContent='朗读：'+(readReplies?'开':'关');
  await chrome.storage.local.set({readReplies});if(!readReplies)call('reply.stop').catch(()=>{});
};
$('reply-stop').onclick=()=>call('reply.stop').catch(error=>toast(error.message));
chrome.storage.local.get('readReplies').then(saved=>{readReplies=saved.readReplies!==false;$('reply-audio').textContent='朗读：'+(readReplies?'开':'关');});


/* ————————————————— 基础工具 ————————————————— */
function h(tag, attrs = {}, html) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  if (html !== undefined) el.innerHTML = html;
  return el;
}

function toast(text, ms = 2200) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

async function call(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res) throw new Error('后台无响应，请在 edge://extensions 里重载扩展后再试');
  if (!res.ok) {
    const err = new Error(res.error || '未知错误');
    err.hint = res.hint;
    err.pageUrl = res.pageUrl;
    throw err;
  }
  return res.data;
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideWelcome() {
  $('welcome')?.classList.add('hidden');
}

function addUser(text) {
  hideWelcome();
  const wrap = h('div', { class: 'msg user' });
  wrap.appendChild(h('div', { class: 'bubble', text }));
  messagesEl.appendChild(wrap);
  scrollBottom();
  return wrap;
}

function addAssistant(markdown, { html = false } = {}) {
  hideWelcome();
  const wrap = h('div', { class: 'msg assistant' });
  const bubble = h('div', { class: 'bubble' });
  if (html) bubble.innerHTML = markdown;
  else bubble.innerHTML = mdToHtml(markdown);
  const speechText=bubble.textContent;
  bubble.appendChild(h('button',{class:'mini-btn',onclick:()=>readReply(speechText)},'朗读'));
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollBottom();
  if(readReplies)readReply(speechText);
  return bubble;
}

function addStatus(text) {
  const row = h('div', { class: 'msg assistant' });
  const box = h('div', { class: 'status' });
  const sp = h('span', { class: 'spinner' });
  const label = h('span', { text });
  box.append(sp, label);
  row.appendChild(box);
  messagesEl.appendChild(row);
  scrollBottom();
  return {
    set(t) {
      label.textContent = t;
    },
    remove() {
      row.remove();
    },
  };
}

function addError(message, extra = {}) {
  const wrap = h('div', { class: 'msg assistant' });
  const box = h('div', { class: 'err-box', text: message });
  if (extra.actions) {
    const row = h('div', { class: 'fix' });
    for (const a of extra.actions) row.appendChild(h('button', { class: 'mini-btn', onclick: a.onClick }, a.label));
    box.appendChild(row);
  }
  wrap.appendChild(box);
  messagesEl.appendChild(wrap);
  scrollBottom();
}

/* ————————————————— Markdown ————————————————— */
function mdToHtml(md) {
  const codes = [];
  let s = String(md || '').replace(/\r\n/g, '\n');
  s = escapeHtml(s);
  s = s.replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, (_, code) => {
    codes.push(code.replace(/\n$/, ''));
    return `\u0000C${codes.length - 1}\u0000`;
  });
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>');

  const lines = s.split('\n');
  const out = [];
  let list = null;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.tag}>`);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    const codeHit = /^\u0000C(\d+)\u0000$/.exec(line);
    if (codeHit) {
      flushPara();
      flushList();
      out.push(`<pre><code>${escapeHtml(codes[Number(codeHit[1])] || '')}</code></pre>`);
      continue;
    }
    if (/^(---+|\*\*\*+)$/.test(line)) {
      flushPara();
      flushList();
      out.push('<hr>');
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      out.push(`<h3>${heading[2]}</h3>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      flushList();
      out.push(`<blockquote>${line.replace(/^>\s?/, '')}</blockquote>`);
      continue;
    }
    const ul = /^[-*•]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)、]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((ul ? ul[1] : ol[1]).replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)] || '')}</code>`));
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join('\n');
}

/* ————————————————— 卡片 ————————————————— */
function sectionTitle(text) {
  return h('div', { class: 'section-title', text });
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function linkCard(item) {
  const a = h('a', { class: 'link-card', href: item.url, target: '_blank', rel: 'noreferrer' });
  const initial = (hostOf(item.url)[0] || '?').toUpperCase();
  a.innerHTML = `
    <div class="link-fav">${escapeHtml(initial)}</div>
    <div class="link-body">
      <div class="link-title">${escapeHtml(item.title || hostOf(item.url))}</div>
      <div class="link-meta">${escapeHtml(hostOf(item.url))}</div>
      ${item.snippet ? `<div class="link-snippet">${escapeHtml(item.snippet)}</div>` : ''}
    </div>`;
  if (item.classification) {
    const c = item.classification;
    a.querySelector('.link-body').appendChild(h('div', {class:'result-labels', text:`${c.category} · ${c.bundle}`}));
    a.querySelector('.link-body').appendChild(h('div', {class:'link-snippet', text:`${c.method}：${c.reason}`}));
  }
  return a;
}

function platformBadge(p) {
  if (p === 'bilibili') return '<span class="badge bili">B站</span>';
  if (p === 'douyin') return '<span class="badge douyin">抖音</span>';
  if (p === 'youtube') return '<span class="badge yt">YouTube</span>';
  return '';
}

function videoCard(v, { onDownload } = {}) {
  const card = h('div', { class: 'video-card' });
  const thumb = v.cover
    ? `<img class="video-thumb" src="${escapeHtml(v.cover)}" onerror="this.style.visibility='hidden'">`
    : '<div class="video-thumb"></div>';
  card.innerHTML = `
    ${thumb}
    <div class="video-info">
      <div class="video-title">${platformBadge(v.platform)}${escapeHtml(v.title)}</div>
      <div class="video-meta">${escapeHtml(
        [v.author, v.durationText, v.play ? `${Math.round(v.play / 1000) / 10}万播放` : ''].filter(Boolean).join(' · '),
      )}</div>
    </div>`;
  const actions = h('div', { class: 'card-actions' });
  actions.appendChild(
    h('button', {
      class: 'mini-btn',
      onclick: () => chrome.tabs.create({ url: v.url, active: true }),
    }, '打开'),
  );
  if (onDownload) {
    actions.appendChild(
      h('button', {
        class: 'mini-btn primary',
        onclick: (ev) => {
          ev.currentTarget.disabled = true;
          onDownload(v);
        },
      }, '下载'),
    );
  }
  const holder = h('div', { class: 'msg assistant' });
  const bubble = h('div', { class: 'bubble' });
  bubble.appendChild(card);
  bubble.appendChild(actions);
  holder.appendChild(bubble);
  messagesEl.appendChild(holder);
  scrollBottom();
  return holder;
}

function translationBlock(src, dst, engine) {
  const wrap = h('div', { class: 'msg assistant' });
  const bubble = h('div', { class: 'bubble' });
  bubble.appendChild(
    h(
      'div',
      { class: 'tr-block' },
      `<div class="tr-src">${escapeHtml(src)}</div><div class="tr-dst">${escapeHtml(dst)}</div>
       <div class="tr-tag"><span>原文 → 译文</span><span>${escapeHtml(engineLabel(engine))}</span></div>`,
    ),
  );
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollBottom();
  return wrap;
}

function engineLabel(e) {
  return { ai: '云端模型', bing: '必应翻译', mymemory: 'MyMemory', google: 'Google', none: '—' }[e] || e || '—';
}

/* ————————————————— 业务动作 ————————————————— */
function activeTab() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]);
}

async function ensureAI() {
  const state = await call('ai.ready').catch(() => ({ ready: false }));
  aiOn = Boolean(state.ready);
  renderAI();
}

function renderAI() {
  $('ai-dot').classList.toggle('on', aiOn);
  $('ai-label').textContent = aiOn ? `${settings.model || '模型'} 已连接` : '未配置模型';
  $('ai-state').textContent = aiOn ? `AI：${settings.model || '已连接'}` : '检索 · 翻译 · 下载';
}

function cleanImageQuery(text) {
  let q = String(text || '').trim();
  q = q.replace(/^(请|麻烦|帮我|帮忙|你能|可以|我想|我要|给我|来)/g, '');
  q = q.replace(/^(找一下|找几张|找几个|找|搜一下|搜|搜索一下|搜索|查一下|来几张|来点|看看)(一下)?/g, '');
  q = q.replace(/(的)?(图片|照片|壁纸|配图|图集|图像|海报|插图|素材|高清图)$/g, '');
  q = q.replace(/(几张|一些|多点|高清|无水印)/g, ' ');
  return q.replace(/\s{2,}/g, ' ').trim() || String(text || '').trim();
}

function imageCell(it, q) {
  const cell = h('div', { class: 'img-cell' });
  const img = h('img', {
    class: 'img-thumb',
    src: it.thumb,
    loading: 'lazy',
    referrerpolicy: 'no-referrer',
    alt: it.title || q,
  });
  img.addEventListener('click', () => chrome.tabs.create({ url: it.page || it.full, active: true }));
  let triedFull = false;
  img.addEventListener('error', () => {
    // 缩略图挂了就退回原图地址
    if (!triedFull && it.full && it.full !== it.thumb) {
      triedFull = true;
      img.src = it.full;
      return;
    }
    cell.classList.add('img-broken');
  });
  const dl = h('button', { class: 'img-dl', title: '保存这张图', text: '⬇' });
  dl.addEventListener('click', (ev) => {
    ev.stopPropagation();
    dl.disabled = true;
    downloadImage(it, q).finally(() => {
      dl.disabled = false;
    });
  });
  cell.append(img, dl);
  return cell;
}

async function downloadImage(it, q) {
  const base = (it.title || q || 'image')
    .slice(0, 40)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .trim();
  const m = /\.(png|jpe?g|webp|gif)(?:$|\?)/i.exec(it.full || it.thumb || '');
  const ext = (m ? m[1] : 'jpg').toLowerCase();
  const name = `${base || 'image'}.${ext}`;
  try {
    const r = await call('file.save', { url: it.full || it.thumb, filename: name, dir: 'EG-AI/图片' });
    toast(r.state === 'pending' ? '图片开始下载…' : '已保存到 下载/' + r.path);
  } catch (e) {
    toast('保存失败：' + e.message);
  }
}

async function runImageSearch(text) {
  const q = cleanImageQuery(text);
  const status = addStatus(`正在搜「${q}」的图片…`);
  try {
    const items = await call('search.images', { query: q });
    status.remove();
    if (!items.length) {
      addAssistant(`没搜到「${q}」的图片。换成更具体的词试试，比如「量子力学 示意图」「猫咪 表情包」。`);
      return;
    }
    const wrap = h('div', { class: 'msg assistant' });
    const bubble = h('div', { class: 'bubble' });
    bubble.appendChild(sectionTitle(`图片 · ${q} · ${items.length} 张`));
    const grid = h('div', { class: 'img-grid' });
    for (const it of items) grid.appendChild(imageCell(it, q));
    bubble.appendChild(grid);
    bubble.appendChild(h('div', { class: 'img-tip', text: '点图打开原图/原页面，右下角 ⬇ 保存到「下载/EG-AI/图片」' }));
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollBottom();
  } catch (e) {
    status.remove();
    addError(`搜图失败：${e.message}`);
  }
}

async function runSearch(userText) {
  const status = addStatus('正在理解你的需求…');
  try {
    let query = userText;
    let translated = null;
    if (settings.autoTranslateInput && isEnglishText(userText)) {
      status.set('识别到英文，先翻译…');
      try {
        const tr = await call('translate.text', { text: userText });
        translated = tr.text;
        query = tr.text;
        translationBlock(userText, tr.text, tr.engine);
      } catch {}
    }

    status.set('正在检索并自动分类网站（官网 / 下载站 / 捆绑风险）…');
    const data = await call('search.combined', { userText: query });
    status.remove();

    if (!data.web.length && !data.videos.length) {
      addAssistant(
        `没搜到「${query}」的有效结果（${data.webError || data.videoError || '搜索引擎返回空'}）。\n\n换个更具体的关键词试试，比如带上领域、年份或平台名。`,
      );
      return;
    }

    const used = data.plan?.queries?.length ? data.plan.queries.join(' / ') : data.query || query;
    addUser(`检索：${userText}`);
    const digest = h('div', { class: 'msg assistant' });
    const bubble = h('div', { class: 'bubble' });
    bubble.appendChild(
      h(
        'div',
        { class: 'muted', html: `关键词：<code>${escapeHtml(used)}</code> · 网站 ${data.web.length} 条 · 视频 ${data.videos.length} 条` },
      ),
    );
    digest.appendChild(bubble);
    messagesEl.appendChild(digest);

    if (data.web.length) {
      const wrap = h('div', { class: 'msg assistant' });
      const b = h('div', { class: 'bubble' });
      b.appendChild(sectionTitle('相关网站'));
      for (const category of [...new Set(data.web.map(item => item.classification?.category || '待核实'))]) {
        b.appendChild(h('div', {class:'result-group', text:category}));
        for (const item of data.web.filter(item => (item.classification?.category || '待核实') === category)) b.appendChild(linkCard(item));
      }
      wrap.appendChild(b);
      messagesEl.appendChild(wrap);
      scrollBottom();
    }
    if (data.videos.length) {
      const wrap = h('div', { class: 'msg assistant' });
      const b = h('div', { class: 'bubble' });
      b.appendChild(sectionTitle('相关视频'));
      for (const v of data.videos) {
        const card = h('div', { class: 'video-card' });
        const thumb = v.cover
          ? `<img class="video-thumb" src="${escapeHtml(v.cover)}" onerror="this.style.visibility='hidden'">`
          : '<div class="video-thumb"></div>';
        card.innerHTML = `${thumb}<div class="video-info"><div class="video-title">${platformBadge(v.platform)}${escapeHtml(
          v.title,
        )}</div><div class="video-meta">${escapeHtml(
          [v.author, v.durationText, v.play ? `${Math.round(v.play / 1000) / 10}万播放` : ''].filter(Boolean).join(' · '),
        )}</div></div>`;
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => chrome.tabs.create({ url: v.url, active: true }));
        b.appendChild(card);
      }
      wrap.appendChild(b);
      messagesEl.appendChild(wrap);
      scrollBottom();
    }

    if (Array.isArray(data.links) && data.links.length) {
      const wrap = h('div', { class: 'msg assistant' });
      const b = h('div', { class: 'bubble' });
      b.appendChild(h('div', { class: 'muted', text: '视频平台没开放搜索接口，可以直接去平台里搜：' }));
      const row = h('div', { class: 'card-actions' });
      for (const l of data.links) {
        row.appendChild(
          h('button', {
            class: 'mini-btn',
            onclick: () => chrome.tabs.create({ url: l.url, active: true }),
          }, l.label),
        );
      }
      b.appendChild(row);
      wrap.appendChild(b);
      messagesEl.appendChild(wrap);
      scrollBottom();
    }

    if (aiOn) {
      const st = addStatus('正在把结果整理成回答…');
      try {
        const md = await call('ai.synthesize', {
          userText: query,
          results: data.web,
          videos: data.videos,
          translated,
        });
        st.remove();
        if (typeof md === 'string' && md.trim()) addAssistant(md);
      } catch (e) {
        st.remove();
      }
    } else {
      addAssistant(
        `上面就是原始检索结果。配置云端模型后，我会挑出最相关的几条并说明为什么相关（⚙ 设置里填 API Key）。`,
      );
    }
  } catch (e) {
    status.remove();
    addError(`检索失败：${e.message}`, {
      actions: [{ label: '打开设置', onClick: openSettings }],
    });
  }
}

async function runDownload(url) {
  const status = addStatus('正在解析链接…');
  let media;
  try {
    const r = await call('media.resolve', { url });
    media = r.media;
    status.remove();
  } catch (e) {
    status.remove();
    const actions = [];
    if (e.pageUrl) actions.push({ label: '打开作品页', onClick: () => chrome.tabs.create({ url: e.pageUrl, active: true }) });
    actions.push({ label: '重试', onClick: () => runDownload(url) });
    addError(`解析失败：${e.message}`, { actions });
    return;
  }

  const wrap = h('div', { class: 'msg assistant' });
  const bubble = h('div', { class: 'bubble' });
  const card = h('div', { class: 'media-card' });
  const cover = media.cover ? `<img class="video-thumb" src="${escapeHtml(media.cover)}" onerror="this.style.visibility='hidden'">` : '';
  card.innerHTML = `
    <div class="media-head">${cover}
      <div class="video-info">
        <div class="media-title">${platformBadge(media.platform)}${escapeHtml(media.title)}</div>
        <div class="media-meta">${escapeHtml(
          [media.author, media.durationText, media.quality, media.sizeText].filter(Boolean).join(' · '),
        )}</div>
      </div>
    </div>
    <div class="progress"><i></i></div>
    <div class="media-state"><span class="spinner"></span><span class="state-text">正在下载…</span></div>`;
  bubble.appendChild(card);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollBottom();

  const stateEl = card.querySelector('.media-state');
  const stream = media.streams?.[0];
  const filename = `${media.title}.mp4`;
  try {
    if (!stream) throw new Error('没解析出可下载的视频流');
    const r = await call('media.save', { streamUrl: stream.url, filename, dir: settings.downloadDir });
    stateEl.className = 'media-state ok';
    stateEl.innerHTML =
      r.state === 'pending'
        ? `<span>⏳ 已开始下载（${escapeHtml(formatBytes(stream.size) || '文件较大')}），可在下载列表看进度</span>`
        : `<span>✓ 已保存到「下载/${escapeHtml(r.path)}」</span>`;
    card.querySelector('.progress')?.remove();
    const actions = h('div', { class: 'card-actions' });
    actions.appendChild(
      h('button', {
        class: 'mini-btn',
        onclick: () => chrome.downloads.show(r.downloadId),
      }, '在文件夹中显示'),
    );
    actions.appendChild(
      h('button', {
        class: 'mini-btn',
        onclick: () => chrome.downloads.open(r.downloadId),
      }, '播放'),
    );
    actions.appendChild(h('button', { class: 'mini-btn', onclick: () => chrome.tabs.create({ url: media.url }) }, '打开原页面'));
    bubble.appendChild(actions);
  } catch (e) {
    stateEl.className = 'media-state err';
    stateEl.innerHTML = `<span>✕ ${escapeHtml(e.message)}</span>`;
    card.querySelector('.progress')?.remove();
    const actions = h('div', { class: 'card-actions' });
    actions.appendChild(
      h('button', {
        class: 'mini-btn',
        onclick: () => {
          chrome.tabs.create({ url: media.url });
          toast('已在页面上打开，可在视频上右键另存');
        },
      }, '打开页面手动保存'),
    );
    actions.appendChild(h('button', { class: 'mini-btn', onclick: () => runDownload(url) }, '重试'));
    bubble.appendChild(actions);
  }
  scrollBottom();
}

async function runTranslate(text) {
  const src = (text || '').trim();
  if (!src) {
    toast('先选中页面文字，或用「翻译选中」');
    return;
  }
  const status = addStatus('正在翻译…');
  try {
    const r = await call('translate.text', { text: src, target: settings.targetLang });
    status.remove();
    translationBlock(src, r.text, r.engine);
  } catch (e) {
    status.remove();
    addError(`翻译失败：${e.message}`);
  }
}

async function getPage() {
  const tab = await activeTab();
  if (!tab || !tab.id) throw new Error('找不到当前标签页');
  if (/^(edge|chrome|about|edge-extension|chrome-extension):/i.test(tab.url || '')) {
    throw new Error('这个页面不允许读取内容，请切到普通网页再试');
  }
  return { tab, page: await call('page.extract', { tabId: tab.id }) };
}

function renderSummary(sum, page) {
  const head = h('div', { class: 'msg assistant' });
  const b = h('div', { class: 'bubble' });
  b.appendChild(
    h('div', {
      class: 'muted',
      html: `📄 <a href="${escapeHtml(page.url)}" target="_blank" rel="noreferrer">${escapeHtml(
        truncate(page.title || page.url, 70),
      )}</a> · 约 ${Math.round(page.text.length / 100) / 10}k 字${
        sum.mode === 'ai' ? ' · 模型总结' : ' · 本地摘要'
      }`,
    }),
  );
  head.appendChild(b);
  messagesEl.appendChild(head);
  addAssistant(sum.markdown);
  if (sum.note) addAssistant(`_${sum.note}_`);
}

async function runSummary() {
  const status = addStatus('正在读取网页…');
  try {
    const { tab, page } = await getPage();
    if (!page.text || page.text.length < 80) {
      status.remove();
      addError('这个页面没抓到正文（可能是视频页、登录页或全是图片）。');
      return;
    }
    status.set(aiOn ? '正在用模型总结要点…' : '正在抽取要点…');
    const sum = await call('page.summarize', { tabId: tab.id, page });
    status.remove();
    renderSummary(sum, page);
  } catch (e) {
    status.remove();
    addError(`总结失败：${e.message}`);
  }
}

// 打开侧边栏时自动总结当前网页（同一 URL 30 分钟内不重复）
async function maybeAutoSummary() {
  if (!settings.autoSummaryOnOpen) return;
  let tab;
  try {
    tab = await activeTab();
  } catch {
    return;
  }
  if (!tab?.id || !/^https?:/i.test(tab.url || '')) return;
  const rec = (await chrome.storage.session.get('autoSummary').catch(() => ({})))?.autoSummary;
  if (rec && rec.url === tab.url && Date.now() - rec.at < 30 * 60 * 1000) return;
  const status = addStatus('正在读取本页…');
  try {
    const page = await call('page.extract', { tabId: tab.id });
    if (!page.text || page.text.length < 800) {
      status.remove();
      return;
    }
    status.set(aiOn ? '自动总结本页要点…' : '自动抽取本页要点…');
    const sum = await call('page.summarize', { tabId: tab.id, page });
    status.remove();
    renderSummary(sum, page);
    await chrome.storage.session.set({ autoSummary: { url: tab.url, at: Date.now() } }).catch(() => {});
  } catch {
    status.remove();
  }
}

async function translateCurrentPage() {
  const tab = await activeTab();
  if (!tab?.id) return;
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: 'page.translateNow' });
    if (r?.ok) {
      toast(r.count ? `已插入 ${r.count} 段中文译文（右下角可开关）` : '页面没有可翻译的英文段落');
    } else toast('这个页面不支持整页翻译');
  } catch {
    toast('这个页面不支持整页翻译（试试普通网页）');
  }
}

async function translateSelection() {
  try {
    const { page } = await getPage();
    if (!page.selection) {
      toast('请先在页面上选中要翻译的文字');
      return;
    }
    await runTranslate(page.selection);
  } catch (e) {
    toast(e.message);
  }
}

/* ————————————————— 路由 ————————————————— */
function classify(text) {
  const urls = extractUrls(text);
  const media = urls.filter((u) => /douyin\.com|iesdouyin\.com|bilibili\.com|b23\.tv|bili2233/i.test(u));
  if (media.length) return { kind: 'download', media };
  if (/^(翻译|translate|译)/i.test(text.trim())) return { kind: 'translate', text: text.replace(/^(翻译|translate|译)[:：\s]*/i, '') };
  if (
    /(图片|配图|壁纸|照片|图集|海报|插画|图标|头像|表情包|截图|示意图|image|images|photo|picture|wallpaper)/i.test(
      text,
    ) &&
    !/(翻译|总结|摘要|概括)/.test(text)
  ) {
    return { kind: 'image', text };
  }
  if (/^(找|搜|来|要|给).{0,12}(几张|几幅|几组|一些).{0,16}(图|照片|壁纸)/.test(text)) {
    return { kind: 'image', text };
  }
  if (/总结|摘要|概括|要点|summary/i.test(text) && /(本页|这页|这个页|当前页|网页|文章|页面|this page|article)/i.test(text)) {
    return { kind: 'summary' };
  }
  if (/整页翻译|翻译整页|translate page/i.test(text)) return { kind: 'page-translate' };
  return { kind: 'search', text };
}

async function handleInput(raw, forceTools = false) {
  const text = String(raw || '').trim();
  if (!text || busy) return;
  hideWelcome();
  if(!forceTools && $('input-mode').value==='chat') {
    busy=true;sendBtn.disabled=true;addUser(text);const status=addStatus('AI 正在回复…');
    chatHistory.push({role:'user',content:text});
    try {const {id}=await call('ai.submit',{messages:chatHistory});status.set('已交给模型在后台执行，可以收起侧边栏…');const reply=await waitAIJob(id);chatHistory.push({role:'assistant',content:reply});if(chatHistory.length>16)chatHistory.splice(0,chatHistory.length-16);addAssistant(reply);}
    catch(error){chatHistory.pop();addError(error.message);}
    finally{status.remove();busy=false;sendBtn.disabled=false;}
    return;
  }
  const task = classify(text);
  try {
    if (task.kind === 'download') {
      addUser(text);
      for (const u of task.media) await runDownload(u);
    } else if (task.kind === 'translate') {
      addUser(text);
      await runTranslate(task.text || text);
    } else if (task.kind === 'image') {
      addUser(text);
      await runImageSearch(task.text || text);
    } else if (task.kind === 'page-translate') {
      addUser(text);
      await translateCurrentPage();
    } else if (task.kind === 'summary') {
      addUser(text);
      await runSummary();
    } else {
      await runSearch(text);
    }
  } catch (e) {
    addError(e.message || String(e));
  }
}

function waitAIJob(id) {
  return new Promise((resolve,reject)=>{
    const key='aiJob:'+id;
    function inspect(job){if(!job||job.status==='running')return;chrome.storage.onChanged.removeListener(listener);sessionStorage.setItem(key,'shown');if(job.error)reject(new Error(job.error));else resolve(job.result);}
    function listener(changes,area){if(area==='local'&&changes[key])inspect(changes[key].newValue);}
    chrome.storage.onChanged.addListener(listener);chrome.storage.local.get(key).then(saved=>inspect(saved[key]));
  });
}
async function restoreAIJobs(){
  const saved=await chrome.storage.local.get(null);
  const jobs=Object.entries(saved).filter(([key,job])=>key.startsWith('aiJob:')&&Date.now()-job.at<86400000&&!sessionStorage.getItem(key)).sort((a,b)=>a[1].at-b[1].at).slice(-5);
  for(const [key,job] of jobs){
    if(job.status==='running'){const status=addStatus('后台任务执行中…');waitAIJob(job.id).then(reply=>{status.remove();addAssistant(reply);},error=>{status.remove();addError(error.message);});}
    else {sessionStorage.setItem(key,'shown');if(job.error)addError(job.error);else addAssistant(job.result);}
  }
}
/* ————————————————— 输入框 ————————————————— */
function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
}

inputEl.addEventListener('input', autoGrow);
inputEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    submit();
  }
});

function submit() {
  const text = inputEl.value;
  if (!text.trim()) return;
  inputEl.value = '';
  autoGrow();
  handleInput(text);
}

sendBtn.addEventListener('click', submit);

/* ————————————————— 设置 ————————————————— */
function openSettings() {
  $('settings').classList.remove('hidden');
  $('mask').classList.remove('hidden');
  fillSettingsForm();
}

function closeSettings() {
  $('settings').classList.add('hidden');
  $('mask').classList.add('hidden');
}

function fillSettingsForm() {
  $('cfg-apiBase').value = settings.apiBase || '';
  $('cfg-apiKey').value = settings.apiKey || '';
  $('cfg-model').value = settings.model || '';
  $('cfg-targetLang').value = settings.targetLang || 'zh-CN';
  $('cfg-downloadDir').value = settings.downloadDir || 'EG-AI';
  $('cfg-translateEngine').value = settings.translateEngine || 'auto';
  $('cfg-autoTranslatePage').checked = settings.autoTranslatePage !== false;
  $('cfg-autoTranslateInput').checked = settings.autoTranslateInput !== false;
  $('cfg-autoSummaryOnOpen').checked = settings.autoSummaryOnOpen !== false;
  $('cfg-videoSearch').checked = settings.videoSearch !== false;
  $('cfg-maxWebResults').value = settings.maxWebResults ?? 12;
  $('cfg-maxVideoResults').value = settings.maxVideoResults ?? 8;
  $('cfg-maxImageResults').value = settings.maxImageResults ?? 12;
}

function readSettingsForm() {
  return {
    apiBase: $('cfg-apiBase').value.trim(),
    apiKey: $('cfg-apiKey').value.trim(),
    model: $('cfg-model').value.trim(),
    targetLang: $('cfg-targetLang').value,
    downloadDir: $('cfg-downloadDir').value.trim() || 'EG-AI',
    translateEngine: $('cfg-translateEngine').value,
    autoTranslatePage: $('cfg-autoTranslatePage').checked,
    autoTranslateInput: $('cfg-autoTranslateInput').checked,
    autoSummaryOnOpen: $('cfg-autoSummaryOnOpen').checked,
    videoSearch: $('cfg-videoSearch').checked,
    maxWebResults: Number($('cfg-maxWebResults').value) || 12,
    maxVideoResults: Number($('cfg-maxVideoResults').value) || 8,
    maxImageResults: Number($('cfg-maxImageResults').value) || 12,
  };
}

$('btn-settings').addEventListener('click', openSettings);
$('btn-close-settings').addEventListener('click', closeSettings);
$('mask').addEventListener('click', closeSettings);

$('btn-save-settings').addEventListener('click', async () => {
  const patch = readSettingsForm();
  settings = await call('settings.save', { settings: patch });
  await ensureAI();
  $('test-result').className = 'test-result ok';
  $('test-result').textContent = '已保存' + (settings.apiKey ? '，可以点「测试模型」验证连通性' : '（未填 Key，走免费通道）');
});

$('btn-test-ai').addEventListener('click', async () => {
  const out = $('test-result');
  const btn = $('btn-test-ai');
  btn.disabled = true;
  out.className = 'test-result';
  out.textContent = '正在测试…';
  try {
    const patch = readSettingsForm();
    settings = await call('settings.save', { settings: patch });
    const r = await call('ai.test');
    out.className = 'test-result ok';
    out.textContent = `连通正常（${r.ms}ms）· 模型回复：${r.reply}`;
    await ensureAI();
  } catch (e) {
    out.className = 'test-result err';
    out.textContent = '测试失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
});

$('btn-reset-settings').addEventListener('click', async () => {
  settings = await call('settings.reset');
  fillSettingsForm();
  await ensureAI();
  $('test-result').className = 'test-result';
  $('test-result').textContent = '已恢复默认';
});

/* ————————————————— 快捷入口 ————————————————— */
document.querySelectorAll('.quick-card').forEach((card) => {
  card.addEventListener('click', () => {
    const kind = card.dataset.quick;
    if (kind === 'search' || kind === 'video' || kind === 'image') {
      $('input-mode').value='tools';
      const q = card.dataset.q || '';
      inputEl.value = q;
      submit();
    } else if (kind === 'translate') {
      translateSelection();
    } else if (kind === 'summary') {
      handleInput('总结本页要点', true);
    } else if (kind === 'download-hint') {
      toast('把抖音/B站分享链接粘进输入框，我会自动解析下载');
      inputEl.focus();
    }
  });
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const kind = chip.dataset.chip;
    if (kind === 'image') {
      const t = inputEl.value.trim();
      if (t) {
        inputEl.value = '';
        autoGrow();
        addUser(t);
        runImageSearch(t);
      } else {
        toast('在输入框写想看的图，比如「赛博朋克 城市 壁纸」');
        inputEl.focus();
      }
    } else if (kind === 'translate-selection') translateSelection();
    else if (kind === 'summary') handleInput('总结本页要点', true);
    else if (kind === 'page-translate') translateCurrentPage();
    else if (kind === 'download-hint') {
      toast('把抖音/B站分享链接粘进输入框，我会自动解析下载');
      inputEl.focus();
    }
  });
});

$('btn-summary').addEventListener('click', () => handleInput('总结本页要点', true));
$('btn-page-translate').addEventListener('click', translateCurrentPage);

/* ————————————————— 面板动作（右键菜单 / 工具栏） ————————————————— */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'panel.action') return;
  const a = msg.action || {};
  if (a.kind === 'translate' && a.text) {
    addUser(a.text);
    runTranslate(a.text);
  } else if (a.kind === 'summarize') {
    handleInput('总结本页要点', true);
  } else if (a.kind === 'download' && a.url) {
    addUser(a.url);
    runDownload(a.url);
  }
});

/* ————————————————— 启动 ————————————————— */
(async function init() {
  try {
    settings = await call('settings.get');
  } catch (e) {
    addError('读取设置失败：' + e.message);
  }
  await ensureAI();
  await restoreAIJobs();
  let handledPending = false;
  try {
    const pending = await call('panel.pending');
    for (const a of pending || []) {
      if (a.kind === 'translate' && a.text) {
        handledPending = true;
        addUser(a.text);
        runTranslate(a.text);
      } else if (a.kind === 'summarize') {
        handledPending = true;
        handleInput('总结本页要点', true);
      } else if (a.kind === 'download' && a.url) {
        handledPending = true;
        addUser(a.url);
        runDownload(a.url);
      }
    }
  } catch {}
  inputEl.focus();
  if (!handledPending && $('input-mode').value==='tools') maybeAutoSummary();
})();

// 调试钩子：sidepanel.html#debug 时暴露内部函数，便于自动化测试
if (location.hash.includes('debug')) {
  window.__egai = {
    handleInput,
    runSearch,
    runDownload,
    runTranslate,
    runSummary,
    renderSummary,
    addUser,
    addAssistant,
    getSettings: () => settings,
    isAI: () => aiOn,
  };
}
