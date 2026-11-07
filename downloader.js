const $ = id => document.getElementById(id);
const active = new Set();
function nameOf(url) { try { return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0,160) || 'download'; } catch { return 'download'; } }
async function start(url) {
  if (!/^https?:\/\//i.test(url) || active.has(url)) return;
  active.add(url);
  const row = document.createElement('article');
  const title = document.createElement('div'); title.textContent = nameOf(url);
  const status = document.createElement('small');
  const progress = document.createElement('progress'); progress.max = 1; progress.value = 0;
  const cancel = document.createElement('button'); cancel.textContent = '取消';
  row.append(title,status,progress,cancel); $('tasks').prepend(row);
  const controller = new AbortController();
  cancel.onclick = () => controller.abort();
  const options = { credentials: 'include', cache: 'no-store', signal: controller.signal };
  let objectUrl;
  let downloadId;
  cancel.onclick = () => {controller.abort();if(downloadId !== undefined) chrome.downloads.cancel(downloadId).catch(()=>{});};
  async function track(id) {
    downloadId=id;
    while(true) {
      const [item]=await chrome.downloads.search({id});
      if(!item) throw new Error('下载任务不存在');
      if(item.totalBytes>0) {progress.value=item.bytesReceived/item.totalBytes;status.textContent=`下载中 · ${(progress.value*100).toFixed(1)}% · ${(item.bytesReceived/1048576).toFixed(1)} / ${(item.totalBytes/1048576).toFixed(1)} MB`;}
      else {progress.removeAttribute('value');status.textContent=`下载中 · ${(item.bytesReceived/1048576).toFixed(1)} MB（总大小未知）`;}
      if(item.state==='complete') {progress.value=1;status.textContent='下载完成';return;}
      if(item.state==='interrupted') throw new Error(item.error || '下载中断');
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
  try {
    status.textContent = '检查分段支持…';
    const probe = await fetch(url, {...options, headers:{Range:'bytes=0-0','Accept-Encoding':'identity'}});
    const match = /^bytes 0-0\/(\d+)$/.exec(probe.headers.get('content-range') || '');
    const size = match ? Number(match[1]) : 0;
    const validator = probe.headers.get('etag') || probe.headers.get('last-modified');
    const mime = probe.headers.get('content-type') || 'application/octet-stream';
    const ranged = probe.status === 206 && size > 0 && size <= 256*1024*1024 && !probe.headers.get('content-encoding');
    await probe.body?.cancel();
    if (!ranged) {
      const id=await chrome.downloads.download({url, filename:nameOf(url),saveAs:true});
      await track(id); return;
    }
    const count = Math.min(Number($('threads').value), size);
    let completed = 0;
    const parts = await Promise.all(Array.from({length:count}, async (_,i) => {
      const begin = Math.floor(size*i/count), end = Math.floor(size*(i+1)/count)-1;
      for(let attempt=0;attempt<3;attempt++) {
        let received = 0;
        try {
          const headers = {Range:`bytes=${begin}-${end}`};
          if (validator && !validator.startsWith('W/')) headers['If-Range'] = validator;
          const response = await fetch(url,{...options,headers});
          if(response.status !== 206 || response.headers.get('content-range') !== `bytes ${begin}-${end}/${size}`) { await response.body?.cancel(); throw new Error('服务器返回的分段范围发生变化'); }
          if(validator && (response.headers.get('etag') || response.headers.get('last-modified')) !== validator) { await response.body?.cancel(); throw new Error('文件已改变，请重新下载'); }
          const reader = response.body.getReader(), chunks = [];
          while(true) {
            const {done,value} = await reader.read(); if(done) break;
            received += value.byteLength;
            if(received > end-begin+1) { await reader.cancel(); throw new Error('分段长度异常'); }
            chunks.push(value); completed += value.byteLength;
            progress.value = completed/size; status.textContent = `${count} 路分段 · ${(completed/size*100).toFixed(1)}%`;
          }
          if(received !== end-begin+1) throw new Error('分段不完整');
          return new Blob(chunks);
        } catch(error) { completed -= received; if(controller.signal.aborted || attempt===2) throw error; }
      }
    }));
    objectUrl = URL.createObjectURL(new Blob(parts,{type:mime}));
    const id = await chrome.downloads.download({url:objectUrl, filename:nameOf(url),saveAs:true});
    status.textContent = '正在保存…';
    await track(id);
    URL.revokeObjectURL(objectUrl);
  } catch(error) { controller.abort(); if(objectUrl) URL.revokeObjectURL(objectUrl); status.textContent = error.name === 'AbortError' ? '已取消' : `下载失败：${error.message}`; }
  finally { active.delete(url); cancel.remove(); }
}
$('form').onsubmit = event => {event.preventDefault();start($('url').value.trim());};
async function render() {
  const {capturedLinks=[]} = await chrome.storage.local.get('capturedLinks');
  $('links').replaceChildren();
  for(const item of capturedLinks) {
    const row = document.createElement('article'), label = document.createElement('div'), info = document.createElement('small'), button = document.createElement('button');
    label.textContent = (item.title ? item.title+' · ' : '') + item.url; info.textContent = `${item.source || '网络捕获'} · ${item.type || ''} · ${item.size ? (item.size/1048576).toFixed(2)+' MB' : '大小未知'}`;
    button.textContent = '下载'; button.onclick = () => start(item.url);
    row.append(label,info,button); $('links').append(row);
  }
}
$('clear').onclick = () => chrome.storage.local.set({capturedLinks:[]});
chrome.storage.onChanged.addListener((changes,area) => {if(area==='local' && changes.capturedLinks) render();});
render();

$('scan').onclick = async () => {
  $('scan-status').textContent = '正在扫描…';
  const tabs = await chrome.tabs.query({});
  const results = await Promise.allSettled(tabs.filter(t => /^https?:/.test(t.url || '')).map(t => chrome.tabs.sendMessage(t.id,{type:'download.scan'})));
  $('scan-status').textContent = `已扫描 ${results.filter(r=>r.status==='fulfilled').length} 个网页；旧网页请刷新后再试`;
};

if(location.hash.length>1) {
  try {const url=decodeURIComponent(location.hash.slice(1));history.replaceState(null,'',location.pathname);$('url').value=url;start(url);}catch{}
}
window.addEventListener('beforeunload',event=>{if(active.size){event.preventDefault();event.returnValue='';}});
