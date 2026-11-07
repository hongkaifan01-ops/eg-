const runningJobs=new Set();
chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
 if(msg.target!=='offscreen-job'||msg.type!=='job.run')return;
 if(runningJobs.has(msg.id)){reply({ok:true});return;}
 runningJobs.add(msg.id);reply({ok:true});
 (async()=>{try{const response=await chrome.runtime.sendMessage({type:'ai.chat',messages:msg.messages});await chrome.runtime.sendMessage({type:'ai.job.finish',id:msg.id,result:response?.data,error:response?.ok?null:(response?.error||'任务失败')});}catch(error){await chrome.runtime.sendMessage({type:'ai.job.finish',id:msg.id,error:error.message});}finally{runningJobs.delete(msg.id);}})();
});
