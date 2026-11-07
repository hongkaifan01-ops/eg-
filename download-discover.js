(() => {
  const file = /\.(exe|msi|msix|msixbundle|appx|apk|dmg|pkg|deb|rpm|zip|7z|rar|iso|mp4|mp3|webm|mkv)(?:[?#]|$)/i;
  const sent = new Set();
  function scan() {
    const links = [];
    for (const el of document.querySelectorAll('a[href],video[src],audio[src],source[src]')) {
      const url = el.href || el.src;
      if (!/^https?:/i.test(url) || sent.has(url)) continue;
      if (!file.test(url) && !el.hasAttribute('download') && !/下载|download/i.test(el.textContent || '')) continue;
      sent.add(url);
      links.push({url, title:(el.textContent || el.getAttribute('download') || '').trim().slice(0,120), source:'页面发现', pageUrl:location.href});
      if (links.length >= 80) break;
    }
    if (links.length) chrome.runtime.sendMessage({type:'download.discover',links}).catch(()=>{});
    if(sent.size > 1000) sent.clear();
  }
  let timer;
  new MutationObserver(() => {clearTimeout(timer);timer=setTimeout(scan,800);}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['href','src']});
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {if(msg.type==='download.scan'){sent.clear();scan();reply({ok:true});}});
  scan();
})();
