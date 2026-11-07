// 离屏文档：把带鉴权/防盗链的视频流 fetch 下来再落盘
function waitDownload(downloadId, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      fn(arg);
    };
    const timer = setTimeout(() => finish(resolve, { state: 'pending' }), timeoutMs);
    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.error?.current) finish(reject, new Error(delta.error.current));
      else if (delta.state?.current === 'complete') finish(resolve, { state: 'complete' });
      else if (delta.state?.current === 'interrupted') finish(reject, new Error('interrupted'));
    };
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function saveBlob({ url, filename }) {
  const res = await fetch(url, { credentials: 'include', mode: 'cors', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || 'video/mp4';
  const buf = await res.arrayBuffer();
  if (!buf.byteLength) throw new Error('文件为空');
  const blob = new Blob([buf], { type: contentType });
  const objUrl = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({ url: objUrl, filename, conflictAction: 'uniquify', saveAs: false });
    const result = await waitDownload(downloadId);
    return { ok: true, downloadId, bytes: buf.byteLength, state: result.state };
  } finally {
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.type === 'save-blob') {
    saveBlob(msg)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});
