// 网页内提示使用 Shadow DOM，避免与站点样式相互影响。
(() => {
  if(window.top!==window) return;
  let host, list, count=0;
  const seen=new Set();
  chrome.runtime.onMessage.addListener(msg=>{
    if(msg.type!=='download.found' || !Array.isArray(msg.items)) return;
    if(!host) {
      host=document.createElement('div');
      host.style.cssText='position:fixed;right:20px;bottom:20px;z-index:2147483647';
      const root=host.attachShadow({mode:'closed'});
      const style=document.createElement('style');
      style.textContent=':host{all:initial}section{font:14px system-ui;width:350px;max-width:85vw;background:#111827;color:#f3f4f6;border:1px solid #6366f1;border-radius:14px;box-shadow:0 10px 45px #0007;padding:16px}header{display:flex;justify-content:space-between;align-items:center}main{max-height:280px;overflow:auto}article{padding:12px 0;border-top:1px solid #374151;margin-top:10px}p{margin:5px 0;overflow-wrap:anywhere}small{color:#9ca3af}button{cursor:pointer;background:#6366f1;color:white;border:0;border-radius:6px;padding:7px 14px;margin-top:8px}';
      const panel=document.createElement('section');panel.setAttribute('role','dialog');panel.setAttribute('aria-label','EG 下载提示');
      const header=document.createElement('header'), title=document.createElement('strong'), close=document.createElement('button');
      title.textContent='EG · 发现可下载资源';close.textContent='关闭';close.onclick=()=>{host.remove();host=null;count=0;};
      header.append(title,close);list=document.createElement('main');panel.append(header,list);root.append(style,panel);document.documentElement.append(host);
    }
    for(const item of msg.items) {
      if(seen.has(item.url) || count>=20) continue;
      seen.add(item.url);count++;
      const row=document.createElement('article'), title=document.createElement('p'), detail=document.createElement('small'), button=document.createElement('button');
      title.textContent=item.title || new URL(item.url).pathname.split('/').pop() || '下载资源';
      detail.textContent=`${new URL(item.url).hostname} · ${item.size ? (item.size/1048576).toFixed(1)+' MB' : '大小未知'} · ${item.source || '发现链接'}`;
      button.textContent='下载';
      button.onclick=async()=>{button.disabled=true;button.textContent='正在打开…';try{const result=await chrome.runtime.sendMessage({type:'download.popup',url:item.url});if(!result?.ok)throw new Error(result?.error || '无法打开下载窗口');button.textContent='已打开进度窗口';}catch(error){button.textContent='重试下载';button.disabled=false;detail.textContent=error.message;}};
      row.append(title,detail,document.createElement('br'),button);list.append(row);
    }
  });
})();
