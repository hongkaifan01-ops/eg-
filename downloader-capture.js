const pending = new Map();
let writing = Promise.resolve();
function save(items) {
  writing = writing.catch(()=>{}).then(async () => {
    const {capturedLinks=[]} = await chrome.storage.local.get('capturedLinks');
    const all = new Map(capturedLinks.map(x=>[x.url,x]));
    for(const item of items) all.set(item.url,{...all.get(item.url),...item,at:Date.now()});
    await chrome.storage.local.set({capturedLinks:[...all.values()].sort((a,b)=>b.at-a.at).slice(0,200)});
    await chrome.action.setBadgeText({text:String(Math.min(all.size,200))});
    await chrome.action.setBadgeBackgroundColor({color:'#6366f1'});
  });
  return writing;
}
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(msg.type!=='download.discover' || !sender.tab || !Array.isArray(msg.links)) return;
  const items=msg.links.slice(0,80).filter(x=>x && /^https?:\/\//i.test(x.url)).map(x=>({url:x.url,title:String(x.title||'').slice(0,120),source:'页面发现（未验证）',pageUrl:sender.tab.url,tabId:sender.tab.id}));
  save(items).then(()=>reply({ok:true}),()=>reply({ok:false}));return true;
});
chrome.webRequest.onHeadersReceived.addListener(details=>{
  if(details.tabId<0 || details.statusCode<200 || details.statusCode>=300) return;
  const headers=Object.fromEntries((details.responseHeaders||[]).map(h=>[h.name.toLowerCase(),h.value||'']));
  const type=headers['content-type']||'';
  if(!/attachment/i.test(headers['content-disposition']||'') && !/^(video|audio)\/|application\/(octet-stream|zip|pdf|x-7z|x-rar|x-msdownload|vnd.microsoft.portable-executable)/i.test(type) && !/\.(exe|msi|msix|apk|dmg|pkg|zip|7z|rar|pdf|mp4|mp3|mkv|webm)(\?|$)/i.test(details.url)) return;
  pending.set(details.url,{url:details.url,tabId:details.tabId,type,size:Number(headers['content-length'])||0,source:'网络捕获'});
  if(pending.size>200) pending.delete(pending.keys().next().value);
  flush();
},{urls:['http://*/*','https://*/*']},['responseHeaders']);
let timer;
function flush(){clearTimeout(timer);timer=setTimeout(()=>{const batch=[...pending.values()];pending.clear();save(batch);},300);}
chrome.downloads.onCreated.addListener(item=>{
  if(!/^https?:\/\//i.test(item.finalUrl||item.url)) return;
  save([{url:item.finalUrl||item.url,title:item.filename?.split(/[\\/]/).pop(),source:'浏览器下载',size:item.totalBytes>0?item.totalBytes:0}]);
});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local' && changes.capturedLinks) chrome.action.setBadgeText({text:changes.capturedLinks.newValue?.length?String(changes.capturedLinks.newValue.length):''});});
// 捕获提示仅发给对应网页的顶层框架，避免 iframe 重复弹出。
const announced = new Map();
chrome.storage.onChanged.addListener((changes,area)=>{
  if(area!=='local' || !changes.capturedLinks) return;
  const byTab=new Map();
  for(const item of changes.capturedLinks.newValue || []) {
    if(!Number.isInteger(item.tabId) || item.tabId<0 || item.source==='浏览器下载') continue;
    const key=`${item.tabId}:${item.url}`;
    if(announced.has(key)) continue;
    announced.set(key,true);
    if(!byTab.has(item.tabId)) byTab.set(item.tabId,[]);
    byTab.get(item.tabId).push(item);
  }
  while(announced.size>1000) announced.delete(announced.keys().next().value);
  for(const [tabId,items] of byTab) chrome.tabs.sendMessage(tabId,{type:'download.found',items},{frameId:0}).catch(()=>{});
});
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(msg.type!=='download.popup' || !sender.tab) return;
  if(!/^https?:\/\//i.test(msg.url || '')) {reply({ok:false,error:'无效的下载地址'});return;}
  chrome.windows.create({url:chrome.runtime.getURL('downloader.html')+'#'+encodeURIComponent(msg.url),type:'popup',width:740,height:650,focused:true}).then(()=>reply({ok:true}),error=>reply({ok:false,error:error.message}));
  return true;
});
