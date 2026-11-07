// 隔离世界：页面正文抽取 / 抖音数据桥接 / 英文页面自动翻译
(() => {
  if (window.__egaiContentLoaded) return;
  window.__egaiContentLoaded = true;

  // —— 抖音 MAIN world 的数据桥 ——
  const douyin = { mediaUrls: [], meta: {}, ts: 0 };
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__egai !== true) return;
    const d = ev.data;
    if (d.kind !== 'douyin-media') return;
    const set = new Set([...(douyin.mediaUrls || []), ...(d.mediaUrls || [])]);
    douyin.mediaUrls = [...set].slice(0, 40);
    douyin.meta = { ...douyin.meta, ...(d.meta || {}) };
    douyin.ts = Date.now();
  });

  // —— 正文抽取 ——
  const NOISE_SEL =
    'nav, aside, header, footer, [role="navigation"], [role="complementary"], [role="banner"], [role="contentinfo"], #sidebar, .sidebar, .nav, .navbar, .menu, .toc, #toc, .table-of-contents, .breadcrumb, .pagination, .comments, #comments';
  const BOILERPLATE =
    /^(press\s|keyboard shortcuts|skip to|table of contents|search results?|share this|advertisement|点击|扫码|关注我们|上一篇|下一篇)/i;

  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest(NOISE_SEL)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    return true;
  }

  function scoreRoot(el) {
    const ps = el.querySelectorAll('p, li');
    let total = 0;
    let n = 0;
    for (const p of ps) {
      if (p.closest(NOISE_SEL)) continue;
      const t = (p.innerText || '').trim();
      if (t.length < 30) continue;
      total += t.length;
      n++;
      if (n > 200) break;
    }
    return total;
  }

  function pickRoot() {
    const seeds = [
      ...document.querySelectorAll(
        'article, main, [role="main"], .article, .post, .entry-content, .markdown-body, #article, #content, .content, .rich_media_content, .article-content, .post-content',
      ),
    ];
    let best = document.body;
    let bestScore = scoreRoot(document.body) * 0.45; // 专门容器更容易胜出
    for (const el of seeds) {
      if (el.closest(NOISE_SEL)) continue;
      const sc = scoreRoot(el);
      if (sc > bestScore) {
        best = el;
        bestScore = sc;
      }
    }
    return best;
  }

  function extractPage() {
    const root = pickRoot();
    const headings = [];
    const chunks = [];
    let total = 0;
    const skip = new Set(['NAV', 'FOOTER', 'ASIDE', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'FORM', 'BUTTON']);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (skip.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (!visible(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const seen = new Set();
    const handle = (el) => {
      const tag = el.tagName;
      const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (!t) return;
      if (BOILERPLATE.test(t)) return;
      const key = t.slice(0, 120);
      if (seen.has(key)) return;
      seen.add(key);

      if (/^H[1-3]$/.test(tag)) {
        headings.push(t.slice(0, 120));
        if (total < 14000) {
          chunks.push(`## ${t}`);
          total += t.length;
        }
        return;
      }
      if (['P', 'LI', 'BLOCKQUOTE', 'PRE', 'TD', 'DD'].includes(tag)) {
        if (t.length < 12) return;
        if (total > 14000) return;
        chunks.push(t);
        total += t.length;
      }
    };

    if (root === document.body) {
      for (const el of root.querySelectorAll('h1,h2,h3,p,li,blockquote,pre,td,dd')) {
        if (!visible(el)) continue;
        handle(el);
      }
    } else {
      handle(root);
      for (const el of root.querySelectorAll('h1,h2,h3,p,li,blockquote,pre,td,dd')) {
        if (!visible(el)) continue;
        handle(el);
      }
    }

    let text = chunks
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text.length < 200) {
      text = (document.body.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 14000);
    }

    const desc =
      document.querySelector('meta[name="description"]')?.content ||
      document.querySelector('meta[property="og:description"]')?.content ||
      '';

    return {
      ok: true,
      page: {
        title: (document.title || '').trim(),
        url: location.href,
        description: desc.slice(0, 300),
        headings: headings.slice(0, 40),
        text: text.slice(0, 14000),
        lang: document.documentElement.lang || '',
        selection: (window.getSelection()?.toString() || '').trim().slice(0, 4000),
        capturedAt: Date.now(),
      },
    };
  }

  // —— 全页中文翻译及悬浮球 ——
  let translatedCount = 0, running = false, autoEnabled = true, generation = 0;
  const originals = new Map();
  let ui, status, toggle;
  const skipTranslation = 'script,style,noscript,code,pre,textarea,input,select,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,#egai-translate-ball';
  function foreignText(text) {
    const letters = (text.match(/[A-Za-z\u00c0-\u024f\u0370-\u052f\u0600-\u06ff\u0900-\u097f\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    const chinese = (text.match(/[\u3400-\u9fff]/g) || []).length;
    return letters >= 2 && chinese < letters * 0.5 && !/^\s*(https?:|www\.|[^\s]+@)/i.test(text);
  }
  function collectBlocks(limit = 60) {
    const blocks = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && blocks.length < limit) {
      const parent = node.parentElement;
      if (!parent || parent.closest(skipTranslation)) continue;
      const text = node.nodeValue;
      if (originals.get(node)?.translated === text || !foreignText(text) || text.length > 4500) continue;
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || !parent.getClientRects().length) continue;
      blocks.push({node,text});
    }
    return blocks;
  }
  function ensureFab() {
    if (ui) return;
    ui = document.createElement('div');ui.id = 'egai-translate-ball';
    ui.style.cssText = 'position:fixed;right:18px;bottom:110px;z-index:2147483600';
    const root = ui.attachShadow({mode:'closed'});
    const style = document.createElement('style');
    style.textContent = ':host{all:initial}button{font:14px system-ui;cursor:pointer;border:0;border-radius:9px;padding:10px;color:#fff;background:#4f46e5}#ball{border-radius:50%;width:52px;height:52px;box-shadow:0 5px 20px #0004}section{font:14px system-ui;background:#111827;color:#fff;border:1px solid #6366f1;padding:14px;border-radius:12px;width:230px;margin-bottom:10px;box-shadow:0 8px 30px #0005}section[hidden]{display:none}section button{display:block;width:100%;margin-top:8px}p{font-size:12px;line-height:1.5;overflow-wrap:anywhere}';
    const menu = document.createElement('section');menu.hidden = true;
    const title = document.createElement('strong');title.textContent = 'EG 网页翻译';
    status = document.createElement('p');status.textContent = '打开网页自动翻译成中文';status.setAttribute('aria-live','polite');
    const translate = document.createElement('button');translate.textContent = '翻译成中文';
    translate.onclick = () => autoTranslate(true).catch(showError);
    const restore = document.createElement('button');restore.textContent = '显示原文';
    restore.onclick = () => {
      generation++;autoEnabled = false;updateToggle();
      for (const [node,item] of originals) if (node.isConnected && node.nodeValue === item.translated) node.nodeValue = item.original;
      originals.clear();translatedCount=0;status.textContent = '已显示原文，本页自动翻译已暂停';
    };
    toggle = document.createElement('button');updateToggle();
    toggle.onclick = async () => {
      autoEnabled = !autoEnabled;updateToggle();
      try {const {settings={}}=await chrome.storage.local.get('settings');await chrome.storage.local.set({settings:{...settings,autoTranslatePage:autoEnabled}});if(autoEnabled) await autoTranslate();}
      catch(error){showError(error);}
    };
    const ball = document.createElement('button');ball.id='ball';ball.textContent='译';ball.title='EG 网页翻译';ball.setAttribute('aria-expanded','false');
    ball.onclick=()=>{menu.hidden=!menu.hidden;ball.setAttribute('aria-expanded',String(!menu.hidden));};
    menu.append(title,status,translate,restore,toggle);root.append(style,menu,ball);document.documentElement.append(ui);
  }
  function updateToggle(){if(toggle)toggle.textContent=`自动翻译：${autoEnabled?'开启':'关闭'}`;}
  function showError(error){if(status)status.textContent=`翻译失败：${error.message}，点击翻译重试`;}
  async function autoTranslate(force = false) {
    if(running || (!force && !autoEnabled)) return;
    if(force) document.documentElement.classList.remove('egai-hide-translations');
    running=true;const current=generation;let failed=false;
    ensureFab();status.textContent='正在翻译成中文…';
    try {
      // 每轮处理最多 240 段，后续由定时任务继续，避免阻塞页面。
      for(let round=0;round<4;round++) {
        if(current!==generation || (!force && !autoEnabled)) break;
        const blocks=collectBlocks();if(!blocks.length)break;
        for(let i=0;i<blocks.length;i+=6) {
          if(current!==generation || (!force && !autoEnabled)) break;
          const batch=blocks.slice(i,i+6);
          const response=await chrome.runtime.sendMessage({type:'translate.batch',texts:batch.map(b=>b.text),target:'zh-CN'});
          if(!response?.ok || !Array.isArray(response.data)) throw new Error(response?.error || '翻译服务未返回结果');
          if(current!==generation)break;
          response.data.forEach((text,k)=>{
            const b=batch[k];if(typeof text!=='string' || !text.trim() || !b?.node.isConnected || b.node.nodeValue!==b.text)return;
            originals.set(b.node,{original:b.text,translated:text});b.node.nodeValue=text;translatedCount++;
          });
          status.textContent=`已翻译 ${translatedCount} 段`;
        }
      }
      if(current===generation)status.textContent=translatedCount?`已翻译 ${translatedCount} 段，可点击显示原文`:'未发现需要翻译的外语文字';
    } catch(error){failed=true;showError(error);}
    finally{running=false;for(const [node] of originals)if(!node.isConnected)originals.delete(node);}
    if(!failed && autoEnabled && collectBlocks(1).length) scheduleTranslate();
  }
  let translateTimer;
  function scheduleTranslate(){clearTimeout(translateTimer);translateTimer=setTimeout(()=>autoTranslate().catch(showError),1800);}
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==='local' && changes.settings){autoEnabled=changes.settings.newValue?.autoTranslatePage!==false;updateToggle();if(autoEnabled)scheduleTranslate();}
  });
  // —— 消息路由 ——
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === 'ping') {
      sendResponse({ ok: true, ts: Date.now() });
      return false;
    }
    if (msg.type === 'page.extract') {
      try {
        sendResponse(extractPage());
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
      return false;
    }
    if (msg.type === 'douyin.capture') {
      sendResponse({
        ok: true,
        mediaUrls: douyin.mediaUrls,
        title: douyin.meta?.title || document.title.replace(/\s*-\s*抖音.*$/, ''),
        author: douyin.meta?.author || '',
        duration: douyin.meta?.duration || 0,
        cover: douyin.meta?.cover || '',
        desc: douyin.meta?.desc || '',
        size: douyin.meta?.size || 0,
        age: Date.now() - douyin.ts,
      });
      return false;
    }
    if (msg.type === 'page.translateNow') {
      autoTranslate(true).then(() => sendResponse({ ok: true, count: translatedCount })).catch(e => sendResponse({ok:false,error:e.message}));
      return true;
    }
    return false;
  });

  async function kick() {
    try {const {settings={}}=await chrome.storage.local.get('settings');autoEnabled=settings.autoTranslatePage!==false;}catch{}
    ensureFab();updateToggle();scheduleTranslate();
    new MutationObserver(records=>{
      if(records.some(r=>!r.target.parentElement?.closest('#egai-translate-ball'))) {if(autoEnabled && !running)scheduleTranslate();}
    }).observe(document.body,{childList:true,subtree:true,characterData:true});
  }
  if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',kick,{once:true});else kick();
})();
