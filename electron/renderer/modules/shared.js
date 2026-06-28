// shared.js
const S = window.S;
export const lucide = window.lucide ? (n,s,c) => window.lucide(n,s,c) : () => '';
window.__pageHandlers = {};
export function showModal({title,message,type='info',buttons,onClose}){return new Promise(r=>{const e=document.querySelector('.modal-overlay');if(e)e.remove();const o=document.createElement('div');o.className='modal-overlay';const b=(buttons||[{text:'确定',value:true,primary:true}]).map(b=>`<button class="${b.primary?'':'secondary'}" data-value="${b.value}">${b.text}</button>`).join('');o.innerHTML=`<div class="modal-card"><div class="modal-header m-${type}">${title}</div><div class="modal-body">${message}</div><div class="modal-footer">${b}</div></div>`;const close=async v=>{if(onClose){const keep=await onClose(v);if(keep===false)return}o.remove();r(v)};o.addEventListener('click',e=>{if(e.target===o)close(null)});o.addEventListener('keydown',e=>{if(e.key==='Escape')close(null)});o.querySelectorAll('button').forEach(b=>{b.addEventListener('click',()=>{let v=b.dataset.value;if(v==='true')v=true;else if(v==='false')v=false;close(v)})});const p=o.querySelector('button:not(.secondary)');if(p)setTimeout(()=>p.focus(),50);document.body.appendChild(o)})}
export async function showAlert(m,t){return showModal({title:'提示',message:m,type:t||'info',buttons:[{text:'确定',value:true,primary:true}]})}
export async function showConfirm(m,o={}){const btns=[{text:o.cancelText||'取消',value:false}];if(o.skipText)btns.push({text:o.skipText,value:'skip'});btns.push({text:o.confirmText||'确定',value:true,primary:true});return showModal({title:o.title||'确认',message:m,type:o.type||'warn',buttons:btns})}
export function showToast(msg,type){const e=document.getElementById('tmpl-toast');if(e)e.remove();const t=document.createElement('div');t.id='tmpl-toast';const c={ok:'#4caf50',warn:'#ff9800',err:'#f44336'};t.style.cssText=`position:fixed;bottom:24px;right:24px;padding:10px 20px;border-radius:6px;color:#fff;background:${c[type]||'#333'};font-size:13px;z-index:9999;opacity:0;transition:opacity .3s;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,.2)`;t.textContent=msg;document.body.appendChild(t);requestAnimationFrame(()=>{t.style.opacity='1'});setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),300)},2000)}
export async function loadDashboard(){
  // 核心数据
  try{
    const s=await window.electronAPI.getDashboardStats();
    document.getElementById('stat-sent').textContent=s.sentToday;
    document.getElementById('stat-remaining').textContent=s.remaining;
    document.getElementById('stat-queue').textContent=S.queue.filter(e=>e.status==='pending').length;
    // 回复率 — 从联系人数据库统计今日回复
    try{
      const contacts=await window.electronAPI.getContacts();
      const today=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Shanghai'})).toISOString().slice(0,10);
      const todayReplied=contacts.filter(c=>c.replied&&(c.repliedAt||'').slice(0,10)===today).length;
      const todaySent=s.sentToday||0;
      document.getElementById('dash-reply-rate').textContent=todaySent>0?(todayReplied/todaySent*100).toFixed(1)+'%':'—';
    }catch(e){document.getElementById('dash-reply-rate').textContent='—';}
    // 退信率 — 从退信日志取今日数据
    try{
      const blog=await window.electronAPI.loadBounceLog();
      const today=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Shanghai'})).toISOString().slice(0,10);
      const todayBounces=(blog.data||blog||[]).filter(b=>(b.date||'').slice(0,10)===today).length;
      const todaySent=s.sentToday||0;
      document.getElementById('dash-bounce-rate').textContent=todaySent>0?(todayBounces/todaySent*100).toFixed(1)+'%':'—';
    }catch(e){document.getElementById('dash-bounce-rate').textContent='—';}
    // 进度条
    const pct=s.dailyLimit>0?Math.round(s.sentToday/s.dailyLimit*100):0;
    document.getElementById('dash-progress-fill').style.width=Math.min(pct,100)+'%';
    document.getElementById('dash-progress-text').textContent=sent>0?`${s.sentToday}/${s.dailyLimit}`:'等待发送';
  }catch(e){document.getElementById('stat-sent').textContent='--'}

  // 账号状态
  try{
    const s=await window.electronAPI.checkSmtpStatus();
    const e=document.getElementById('stat-smtp');
    if(s.accountCount!=null){e.textContent=s.ok?`${s.activeCount}/${s.accountCount}`:'0';e.style.color=s.ok?'var(--success)':'var(--warning)'}else{e.textContent=s.ok?'已连接':'未配置';e.style.color=s.ok?'var(--success)':'var(--warning)'}
  }catch(e){}

  // 发送窗口
  try{
    const cfg=await window.electronAPI.loadConfig();
    const sc=cfg?.schedule||{};
    const startH=sc.start_hour_beijing??19,endH=sc.end_hour_beijing??3;
    const h=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Shanghai'})).getHours();
    const inWin=startH<endH?h>=startH&&h<endH:h>=startH||h<endH;
    const el=document.getElementById('dash-window');
    el.className='dash-metric-value small';
    el.textContent=startH+':00 ~ '+endH+':00'+(endH<10?' (次日)':'');
    el.style.color=inWin?'var(--success)':'var(--text-secondary)';
  }catch(e){}

  // 最近动态消息流
  try{
    const result=await window.electronAPI.getSendLog({limit:8,offset:0});
    const items=(result.records||[]).slice(0,5);
    const feed=document.getElementById('dash-feed-list');
    if(!items.length){feed.innerHTML='<span style="font-size:12px;color:var(--text-secondary)">暂无活动</span>';}else{
      feed.innerHTML=items.map(r=>{
        const t=r.time?new Date(new Date(r.time).getTime()+8*3600000).toISOString().slice(11,16):'';
        if(r.status==='failed')return`<div class="dash-feed-item"><span class="dash-feed-dot bounce"></span>${escapeHtml(r.company||'?')} 退信<span class="dash-feed-time">${t}</span></div>`;
        if(r._stage&&r._stage!=='cold')return`<div class="dash-feed-item"><span class="dash-feed-dot reply"></span>${escapeHtml(r.company||'?')} 回复<span class="dash-feed-time">${t}</span></div>`;
        return`<div class="dash-feed-item"><span class="dash-feed-dot sent"></span>${escapeHtml(r.company||'?')}<span class="dash-feed-time">${t}</span></div>`;
      }).join('');
    }
  }catch(e){}
}

// 快捷操作按钮
document.addEventListener('click',function(e){
  const btn=e.target.closest('[data-nav]');
  if(!btn)return;
  const page=btn.dataset.nav;
  if(page==='compose')document.querySelector('.nav-item[data-page="compose"]')?.click();
  else document.querySelector('.nav-item[data-page="'+page+'"]')?.click();
});
document.getElementById('dash-bounce-check')?.addEventListener('click',function(){
  document.querySelector('.nav-sub[data-page="bounces"]')?.click();
  setTimeout(()=>{const b=document.getElementById('bounce-run-btn');if(b)b.click();},300);
});
export function initNavigation(){const n=document.querySelectorAll('.nav-item');const s=document.querySelectorAll('.nav-sub');const p=document.querySelectorAll('.page');document.querySelector('.nav-parent')?.addEventListener('click',function(e){e.stopPropagation();this.classList.toggle('open');s.forEach(s=>s.classList.toggle('show'))});[...n,...s].forEach(i=>{if(i.classList.contains('nav-parent'))return;i.addEventListener('click',()=>{n.forEach(n=>n.classList.remove('active'));s.forEach(s=>s.classList.remove('active'));i.classList.add('active');if(i.classList.contains('nav-sub'))document.querySelector('.nav-parent')?.classList.add('active');p.forEach(p=>p.classList.remove('active'));const id=i.dataset.page;document.getElementById(`page-${id}`)?.classList.add('active');window.__pageHandlers[id]?.()})})}
export function findById(a,i){return a?.find(x=>x.id===i)}
export function truncate(s,l){return s?.length>l?s.slice(0,l)+'...':s}
export function escapeHtml(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/`/g,'&#96;')}
export function formatDate(i){if(!i)return'—';const d=new Date(i);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
export function daysSince(i){if(!i)return'';const n=new Date(),t=new Date(i),nu=Date.UTC(n.getUTCFullYear(),n.getUTCMonth(),n.getUTCDate()),tu=Date.UTC(t.getUTCFullYear(),t.getUTCMonth(),t.getUTCDate());const d=Math.floor((nu-tu)/86400000);return d>=0?`${d}天`:''}
export function ratingStars(n){const r=Math.min(5,Math.max(0,n));return'<span style="color:#f0a500;font-size:11px;letter-spacing:1px">'+'★'.repeat(r)+'☆'.repeat(5-r)+'</span>'}
export function deepMerge(b,o){const out={...b};for(const k of Object.keys(o)){if(o[k]&&typeof o[k]==='object'&&!Array.isArray(o[k])&&b[k]&&typeof b[k]==='object')out[k]=deepMerge(b[k],o[k]);else out[k]=o[k]}return out}
export async function pollBackcheckStatus(c,onDone){for(let i=0;i<45;i++){await new Promise(r=>setTimeout(r,2000));const s=await window.electronAPI.getBackcheckStatus();const st=s[c];if(st?.status==='done'||st?.status==='timeout'){onDone();return}}onDone()}
export function renderMarkdown(md){let h=escapeHtml(md);h=h.replace(/^#### (.+)$/gm,'<h4>$1</h4>').replace(/^### (.+)$/gm,'<h3>$1</h3>').replace(/^## (.+)$/gm,'<h2>$1</h2>').replace(/^# (.+)$/gm,'<h1>$1</h1>');h=h.replace(/^---$/gm,'<hr>').replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');h=h.replace(/((?:^\|.+\|$\n?)+)/gm,(m)=>{const l=m.trim().split('\n').filter(l=>!/^\|[\s:\-|]+\|$/.test(l));if(l.length<1)return m;let t='<table>';l.forEach((l,i)=>{const c=l.split('|').filter(c=>c.trim());const tag=i===0?'th':'td';t+='<tr>'+c.map(c=>`<${tag}>${c.trim()}</${tag}>`).join('')+'</tr>'});return t+'</table>'});h=h.replace(/^- (.+)$/gm,'<li>$1</li>').replace(/^\d+\.\s+(.+)$/gm,'<li>$1</li>');h=h.replace(/((?:<li>.*<\/li>\n?)+)/g,(m)=>m.includes('<li>')?'<ul>'+m+'</ul>':m);h=h.replace(/^&gt; (.+)$/gm,'<blockquote>$1</blockquote>');const b=h.split('\n\n');h=b.map(b=>{const t=b.trim();if(!t)return'';if(/^<(h[1-4]|hr|table|ul|ol|li|div|blockquote)/.test(t))return t.replace(/\n/g,'');return'<p>'+t.replace(/\n/g,'<br>')+'</p>'}).join('');return h}
export function renderPagination(c,total,cur,onChange){if(!c)return;const tp=Math.ceil(total/S.PAGE_SIZE);if(tp<=1){c.style.display='none';return}c.style.display='flex';let h=`<button ${cur===1?'disabled':''} data-p="1">«</button><button ${cur===1?'disabled':''} data-p="${cur-1}">‹</button>`;for(let i=1;i<=tp;i++){if(i===1||i===tp||(i>=cur-2&&i<=cur+2))h+=`<button class="${i===cur?'active':''}" data-p="${i}">${i}</button>`;else if(i===cur-3||i===cur+3)h+='<span>…</span>'}h+=`<button ${cur===tp?'disabled':''} data-p="${cur+1}">›</button><button ${cur===tp?'disabled':''} data-p="${tp}">»</button>`;c.innerHTML=h;c.querySelectorAll('button[data-p]').forEach(b=>{b.addEventListener('click',()=>onChange(parseInt(b.dataset.p)))})}
export function populateSelect(id,items){const s=document.getElementById(id);if(!s)return;s.innerHTML=items.map(i=>`<option value="${i[0]}">${i[1]}</option>`).join('')}
export function statusLabel(s){const m={pending:`${lucide('clock',14)} 待发送`,sent:`${lucide('check-circle',14)} 已发送`,failed:`${lucide('x-circle',14)} 失败`,sending:`${lucide('refresh-cw',14,'spin')} 发送中`};return m[s]||s}
export function initIcons(root=document){root.querySelectorAll('[data-icon]').forEach(e=>{const n=e.dataset.icon;if(!n)return;let s=18;if(e.classList.contains('drop-icon'))s=32;else if(e.classList.contains('nav-arrow'))s=14;else if(e.closest('button'))s=12;else if(e.closest('h2'))s=20;else if(e.closest('h3'))s=16;else if(e.closest('h4'))s=14;e.innerHTML=lucide(n,s)})}
export async function checkNetworkStatus(){try{const r=await window.electronAPI.checkNetwork();const p=S.foreignNetworkOk;if(r){S.foreignNetworkOk=true;S.networkStatusDismissed=false;if(!p){const e=document.getElementById('network-status');if(e){e.style.display='none'}}return}S.foreignNetworkOk=false;if(S.networkStatusDismissed)return;const e=document.getElementById('network-status');if(e){e.textContent='网络不可用';e.style.display='block';e.style.cssText='padding:8px 16px;background:var(--danger);color:#fff;text-align:center;font-size:12px;cursor:pointer';e.onclick=()=>{S.networkStatusDismissed=true;e.style.display='none'}}}catch{}}
export function clientTypeTag(t){var m={};m.agent=lucide('globe',12)+' 代理';m.direct=lucide('building',12)+' 直客';m.unlabeled='';m.agent='<span class="ctype-tag ctype-agent">'+m.agent+'</span>';m.direct='<span class="ctype-tag ctype-direct">'+m.direct+'</span>';return m[t]||''}
export function groupByCompany(data){const g={};for(const c of data){const k=c.company||'未命名';if(!g[k])g[k]=[];g[k].push(c)}return Object.entries(g).sort((a,b)=>a[0].localeCompare(b[0]))}
window.addEventListener('error',(e)=>{const m=`JS错误: ${e.message} (${e.filename}:${e.lineno})`;console.error(m,e.error);const b=document.createElement('div');b.style.cssText='position:fixed;top:0;left:0;right:0;background:#f44336;color:#fff;padding:8px 16px;font-size:12px;z-index:99999';b.textContent=m;document.body.prepend(b)});
window.__pageHandlers['dashboard'] = loadDashboard;
