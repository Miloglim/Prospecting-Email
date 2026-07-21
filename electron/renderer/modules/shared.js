// shared.js
const S = window.S;
import CS from './company-state.js';

// ── 国家 → 模板语言映射 ──────────────────────────────────────────────────
// ponytail: 统一入口，替换散落各处的 includes('Brasil') / === 'Brazil' 判断
// 优先精确匹配 ISO 代码，避免 BR→English 等误判
export function countryToLang(country) {
  const c = (country || '').toLowerCase().trim();
  // ISO 代码精确匹配（优先，避免 "BR" 被漏掉）
  const ISO_PT = ['br', 'pt', 'ao', 'mz', 'cv', 'gw', 'st', 'tl'];
  const ISO_ES = ['mx', 'co', 'cl', 'pe', 'ar', 'ec', 'bo', 'py', 'uy', 'pa', 'cr', 've', 'gt', 'sv', 'hn', 'ni', 'do', 'cu', 'pr', 'es'];
  const ISO_EN = ['us', 'gb', 'uk', 'ca', 'au', 'nz', 'de', 'fr', 'it', 'nl', 'be', 'jp', 'kr', 'cn', 'in', 'sg', 'ae'];
  if (ISO_PT.includes(c)) return 'pt';
  if (ISO_ES.includes(c)) return 'es';
  if (ISO_EN.includes(c)) return 'en';
  // 完整国名模糊匹配
  const ptCountries = [
    'brazil','brasil','巴西',
    'portugal','葡萄牙',
    'angola','安哥拉',
    'moçambique','mozambique','莫桑比克',
    'cabo verde','cape verde','佛得角',
    'guiné-bissau','guine-bissau','guinea-bissau','几内亚比绍',
    'são tomé','sao tome','圣多美','príncipe','principe',
    'timor-leste','east timor','东帝汶',
  ];
  if (ptCountries.some(k => c.includes(k))) return 'pt';
  const esCountries = [
    'mexico','méxico','墨西哥',
    'colombia','哥伦比亚',
    'chile','智利',
    'peru','perú','秘鲁',
    'argentina','阿根廷',
    'ecuador','厄瓜多尔',
    'bolivia','玻利维亚',
    'paraguay','巴拉圭',
    'uruguay','乌拉圭',
    'panama','panamá','巴拿马',
    'costa rica','哥斯达黎加',
    'venezuela','委内瑞拉',
    'guatemala','危地马拉',
    'el salvador','萨尔瓦多',
    'honduras','洪都拉斯',
    'nicaragua','尼加拉瓜',
    'dominican republic','república dominicana','多米尼加',
    'cuba','古巴',
    'puerto rico','波多黎各',
    'spain','españa','西班牙',
  ];
  if (esCountries.some(k => c.includes(k))) return 'es';
  const enCountries = [
    'usa','united states','美国',
    'united kingdom','england','英国',
    'canada','加拿大',
    'australia','澳大利亚',
    'new zealand','新西兰',
    'germany','德国','deutschland',
    'france','法国',
    'italy','意大利','italia',
    'netherlands','holland','荷兰',
    'belgium','比利时',
    'japan','日本',
    'south korea','korea','韩国',
    'china','中国',
    'india','印度',
    'singapore','新加坡',
    'uae','dubai','阿联酋','迪拜',
  ];
  if (enCountries.some(k => c.includes(k))) return 'en';
  // 无法识别 → 英语
  return 'en';
}
export const lucide = window.lucide ? (n,s,c) => window.lucide(n,s,c) : () => '';
window.__pageHandlers = {};
export function showModal({title,message,type='info',buttons,onClose,closeOnOverlay=true}){return new Promise(r=>{const e=document.querySelector('.modal-overlay');if(e)e.remove();const o=document.createElement('div');o.className='modal-overlay';const b=(buttons||[{text:'确定',value:true,primary:true}]).map(b=>`<button class="${b.primary?'':'secondary'}" data-value="${b.value}">${b.text}</button>`).join('');o.innerHTML=`<div class="modal-card"><div class="modal-header m-${type}">${title}</div><div class="modal-body">${message}</div><div class="modal-footer">${b}</div></div>`;const close=async v=>{if(onClose){const keep=await onClose(v);if(keep===false)return}o.remove();r(v)};if(closeOnOverlay){o.addEventListener('click',e=>{if(e.target===o)close(null)})}o.addEventListener('keydown',e=>{if(e.key==='Escape')close(null)});o.querySelectorAll('button').forEach(b=>{b.addEventListener('click',()=>{let v=b.dataset.value;if(v==='true')v=true;else if(v==='false')v=false;close(v)})});const p=o.querySelector('button:not(.secondary)');if(p)setTimeout(()=>p.focus(),50);document.body.appendChild(o)})}
export async function showAlert(m,t){return showModal({title:'提示',message:m,type:t||'info',buttons:[{text:'确定',value:true,primary:true}]})}
export async function showConfirm(m,o={}){const btns=[{text:o.cancelText||'取消',value:false}];if(o.skipText)btns.push({text:o.skipText,value:'skip'});btns.push({text:o.confirmText||'确定',value:true,primary:true});return showModal({title:o.title||'确认',message:m,type:o.type||'warn',buttons:btns})}
export function showToast(msg,type){const e=document.getElementById('tmpl-toast');if(e)e.remove();const t=document.createElement('div');t.id='tmpl-toast';const c={ok:'#4caf50',warn:'#ff9800',err:'#f44336'};t.style.cssText=`position:fixed;bottom:24px;right:24px;padding:10px 20px;border-radius:6px;color:#fff;background:${c[type]||'#333'};font-size:13px;z-index:9999;opacity:0;transition:opacity .3s;pointer-events:none;box-shadow:0 4px 12px rgba(0,0,0,.2)`;t.textContent=msg;document.body.appendChild(t);requestAnimationFrame(()=>{t.style.opacity='1'});setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),300)},2000)}
// 设置版本号（一次性）
let _versionSet = false;
async function initVersion() {
  if (_versionSet) return;
  try { const v = await window.electronAPI.getAppVersion(); const el = document.getElementById('nav-version'); if (el) el.textContent = 'v' + v; _versionSet = true; } catch { /* 渲染层降级：操作失败不影响 UI */ }
}

export async function loadDashboard(){
  initVersion();
  // 核心数据
  try{
    const s=await window.electronAPI.getDashboardStats();
    document.getElementById('stat-sent').textContent=s.sentToday;
    document.getElementById('stat-remaining').textContent=s.remaining;
    document.getElementById('stat-queue').textContent=S.queue.filter(e=>e.status==='pending').length;
    // 回复邮件 — 独立计数器（删联系人不影响），区分今日/累计
    try{
      const rc=await window.electronAPI.getReplyCount();
      const contactsAll=await window.electronAPI.getContacts();
      const totalContacts=contactsAll.length;
      const sentToday=s.sentToday||0;
      // 卡片大数字
      document.getElementById('dash-reply-rate').textContent=rc.total>0?rc.total:'—';
      // 副标题：今日/累计 + 触达率
      const globalRate=totalContacts>0?(rc.total/totalContacts*100).toFixed(1):'0.0';
      const todayRate=sentToday>0?(rc.today/sentToday*100).toFixed(1):'0.0';
      document.getElementById('dash-reply-label').textContent=`回复邮件 · 今日${rc.today} 累计${rc.total} · 触达率 ${globalRate}% · 今日 ${todayRate}%`;
      // 今日新增线索
      const today=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Shanghai'})).toISOString().slice(0,10);
      const todayNew=contactsAll.filter(c=>(c.addedAt||'').slice(0,10)===today);
      const newCompanies=new Set(todayNew.map(c=>c.company).filter(Boolean)).size;
      document.getElementById('stat-new').textContent=todayNew.length?`${todayNew.length}人 / ${newCompanies}家`:'—';
    }catch(e){document.getElementById('dash-reply-rate').textContent='—';document.getElementById('stat-new').textContent='—';}
    // 退回邮件 — 独立计数器，仅今日
    try{
      const bc=await window.electronAPI.getBounceCount();
      document.getElementById('dash-bounce-rate').textContent=bc.today>0?bc.today:'—';
      document.getElementById('dash-bounce-label').textContent='退回邮件';
    }catch(e){document.getElementById('dash-bounce-rate').textContent='—';}
    // 进度条
    const pct=s.dailyLimit>0?Math.round(s.sentToday/s.dailyLimit*100):0;
    document.getElementById('dash-progress-fill').style.width=Math.min(pct,100)+'%';
    document.getElementById('dash-progress-text').textContent=s.sentToday>0?`${s.sentToday}/${s.dailyLimit}`:'等待发送';
  }catch(e){document.getElementById('stat-sent').textContent='--'}

  // 账号状态
  try{
    const s=await window.electronAPI.checkSmtpStatus();
    const as=await window.electronAPI.getAccountStatus();
    const e=document.getElementById('stat-smtp');
    if(s.accountCount!=null){
      const active=s.activeCount;
      const total=s.accountCount;
      const pass=s.passedCount||0;
      const failed=s.failedCount||0;
      const fusedCount=(as.data||[]).filter(a=>a.fused).length;
      // 分母只在全通时变绿，其余黑色
      const denomColor = (pass===total && failed===0 && fusedCount===0) ? '#4caf50' : 'var(--text)';
      const sh=`<span style="color:${denomColor}">/</span>`;
      if(active===0){
        e.innerHTML=`<span style="color:#e65100">0</span>${sh}<span style="color:${denomColor}">${total}</span>`;
      }else if(fusedCount>0){
        e.innerHTML=`<span style="color:#ff9800">${active}</span>${sh}<span style="color:${denomColor}">${total}</span> <span style="color:#ff9800">⚡${fusedCount}</span>`;
      }else if(failed>0){
        e.innerHTML=`<span style="color:#e65100">${active}</span>${sh}<span style="color:${denomColor}">${total}</span>`;
      }else if(pass===total&&pass>0){
        e.innerHTML=`<span style="color:#4caf50">${active}</span>${sh}<span style="color:${denomColor}">${total}</span>`;
      }else{
        e.innerHTML=`<span style="color:var(--text-secondary)">${active}</span>${sh}<span style="color:${denomColor}">${total}</span>`;
      }
    }else{e.textContent=s.ok?'已连接':'未配置';e.style.color=s.ok?'var(--success)':'var(--warning)'}
  }catch(e){}

  // 发送窗口
  try{
    const cfg=await window.electronAPI.loadConfig();
    const sc=cfg?.schedule||{};
    const startH=sc.start_hour_beijing??19,endH=sc.end_hour_beijing??3;
    const windowEnabled=sc.time_window_enabled!==false; // 默认开启
    const h=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Shanghai'})).getHours();
    const inWin=startH<endH?h>=startH&&h<endH:h>=startH||h<endH;
    const el=document.getElementById('dash-window');
    el.className='dash-metric-value small';
    el.textContent=startH+':00 ~ '+endH+':00'+(endH<10?' (次日)':'');
    el.style.color=windowEnabled?(inWin?'var(--success)':'var(--text-secondary)'):'var(--text-secondary)';
  }catch(e){}

  // 客户跟进：CRM 管线阶段 + 待办详情
  try{
    const pr=await window.electronAPI.crmListPipeline({});
    let allPipelineContacts=[];
    const contactStageMap={}; // id → stage label
    if(pr.ok&&pr.data){
      const cols=pr.data.columns||[];
      const parts=cols.map(c=>`${c.label} ${c.contacts.length}`).join(' · ');
      const total=cols.reduce((s,c)=>s+c.contacts.length,0);
      document.getElementById('dash-stage-dist').textContent=parts||'暂无跟进客户';
      document.getElementById('dash-stage-dist').style.color=total>0?'var(--text)':'var(--text-secondary)';
      const seen=new Set();
      for(const col of cols){
        for(const c of col.contacts){
          if(!seen.has(c.id)){seen.add(c.id);allPipelineContacts.push(c);}
          contactStageMap[c.id]=col.label;
        }
      }
    }else{
      document.getElementById('dash-stage-dist').textContent='加载失败';
    }
    // 待办详情（逐条记录，含缺失字段明细）
    try{
      const PREF_LABELS={preferredRoutes:'偏好路线',cargoTypes:'货物类型',decisionRole:'决策角色',priceSensitivity:'价格敏感度',preferredPorts:'偏好港口',annualVolume:'年货量'};
      const PREFS_KEYS=Object.keys(PREF_LABELS);
      const items=[]; // { type:'overdue'|'due'|'missing', name, company, detail }
      const now=Date.now();
      // 1) CRM 跟进提醒
      const rm=await window.electronAPI.crmCheckReminders();
      if(rm.ok&&rm.data){
        for(const r of(rm.data.overdue||[])){
          const days=Math.ceil((now-new Date(r._extra?.crmReminder?.nextFollowupAt).getTime())/(86400000))||1;
          const name=(r.first_name||'')+' '+(r.last_name||'');
          items.push({type:'overdue',name:name.trim()||r.email,company:r.company_name||'',detail:`跟进逾期${days}天`});
        }
        for(const r of(rm.data.due||[])){
          const name=(r.first_name||'')+' '+(r.last_name||'');
          items.push({type:'due',name:name.trim()||r.email,company:r.company_name||'',detail:'今日跟进'});
        }
      }
      // 2) 字段完整性：逐人列出缺失的偏好字段
      for(const c of allPipelineContacts){
        let extra={};
        try{extra=typeof c._extra==='string'?JSON.parse(c._extra):(c._extra||{});}catch{}
        const p=extra.crmPreferences||{};
        const missing=PREFS_KEYS.filter(k=>!p[k]||(typeof p[k]==='string'&&!p[k].trim()));
        if(!missing.length) continue;
        const name=(c.first_name||'')+' '+(c.last_name||'');
        items.push({type:'missing',name:name.trim()||c.email,company:c.company_name||c.company||'',detail:`缺${missing.map(k=>PREF_LABELS[k]).join('/')}`,contactId:c.id});
      }
      // 3) 待办助手：显式跟进日期 + 自动计算（last_sent_at + 阶段间隔）
      const STAGE_INTERVAL={cold:3,f1:4,f2:5,f3:6};
      const seenIds=new Set(items.map(i=>i.contactId).filter(Boolean));
      for(const c of allPipelineContacts){
        if(seenIds.has(c.id)) continue;
        let extra={};
        try{extra=typeof c._extra==='string'?JSON.parse(c._extra):(c._extra||{});}catch{}
        let dueTime=0,autoLabel='';
        // 优先显式日期，否则自动计算
        const na=extra.crmReminder?.nextFollowupAt;
        if(na){dueTime=new Date(na).getTime();}
        else if(c.last_sent_at&&c.stage&&c.stage!=='f4'){
          const interval=STAGE_INTERVAL[c.stage]||3;
          dueTime=new Date(c.last_sent_at).getTime()+interval*86400000;
          autoLabel='(自动)';
        }
        if(!dueTime||isNaN(dueTime)) continue;
        // 日历日比较：对齐到午夜，避免"明天设的日期今晚就变今日"
        const nowDay=new Date(now).setHours(0,0,0,0);
        const dueDay=new Date(dueTime).setHours(0,0,0,0);
        const dayDiff=Math.round((dueDay-nowDay)/86400000);
        const name=(c.first_name||'')+' '+(c.last_name||'');
        const label=name.trim()||c.email;
        const company=c.company_name||c.company||'';
        if(dayDiff<=-1){
          items.push({type:'overdue',name:label,company,detail:`逾期${Math.abs(dayDiff)}天${autoLabel}`,contactId:c.id});
        }else if(dayDiff<=0){
          items.push({type:'due',name:label,company,detail:`今日跟进${autoLabel}`,contactId:c.id});
        }else{
          items.push({type:'upcoming',name:label,company,detail:`还有${dayDiff}天${autoLabel}`,contactId:c.id});
        }
      }
      // 排序：逾期 → 今日到期 → 即将 → 缺失
      items.sort((a,b)=>{const o={overdue:0,due:1,upcoming:2,missing:3};return o[a.type]-o[b.type]||a.name.localeCompare(b.name);});
      // 渲染
      const box=document.getElementById('dash-todo-box');
      if(!items.length){
        box.innerHTML='<span style="color:var(--success);font-size:11px">✓ 无待办</span>';
      }else{
        const TYPE_COLOR={overdue:'var(--danger)',due:'#e65100',upcoming:'var(--success)',missing:'var(--text-secondary)'};
        const TYPE_DOT={overdue:'var(--danger)',due:'#ff9800',upcoming:'#22a644',missing:'#9e9e9e'};
        box.innerHTML=items.map(i=>{
          const label=i.company?`${i.name}(${i.company})`:i.name;
          const cid=i.contactId?` data-contact-id="${escapeHtml(i.contactId)}"`:'';
          const cls=i.contactId?' class="dash-todo-item dash-todo-clickable"':'class="dash-todo-item"';
          return `<div${cls}${cid}><span class="dash-todo-dot" style="background:${TYPE_DOT[i.type]}"></span><span style="color:${TYPE_COLOR[i.type]}">${escapeHtml(label)}</span> <span style="color:var(--text-secondary)">${escapeHtml(i.detail)}</span></div>`;
        }).join('');
        // 点击字段缺失条目 → 跳转 CRM 联系人详情
        box.querySelectorAll('.dash-todo-clickable').forEach(el=>{
          el.addEventListener('click',()=>{
            const cid=el.dataset.contactId;
            if(!cid) return;
            // 导航到 CRM 页面
            const nav=document.querySelector('[data-page="crm"]');
            if(nav) nav.click();
            // 等页面渲染后打开详情
            setTimeout(()=>{if(window.__crmOpenDetail) window.__crmOpenDetail(cid);},400);
          });
        });
      }
    }catch(e){document.getElementById('dash-todo-box').innerHTML='<span class="dash-todo-item">—</span>';}
  }catch(e){document.getElementById('dash-stage-dist').textContent='—';document.getElementById('dash-todo-list').innerHTML='<span class="dash-todo-item">—</span>';}
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
  document.querySelector('.nav-item[data-page="inbox"]')?.click();
  setTimeout(()=>{const b=document.getElementById('inbox-refresh');if(b)b.click();},300);
});
document.getElementById('dash-gen-report')?.addEventListener('click',async function(){
  const btn=document.getElementById('dash-gen-report');
  btn.disabled=true;btn.textContent='生成中...';
  try{
    const r=await window.electronAPI.generateReport();
    if(!r.ok){alert('生成失败: '+r.error);return}
    await window.electronAPI.openPath(r.data.path);
  }catch(e){alert('生成失败: '+e.message)}
  finally{btn.disabled=false;btn.textContent='生成今日报告';}
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
export async function checkNetworkStatus(){try{const r=await window.electronAPI.checkNetwork();const p=S.foreignNetworkOk;if(r){S.foreignNetworkOk=true;CS.setNetworkDismissed(false);if(!p){const e=document.getElementById('network-status');if(e){e.style.display='none'}}return}S.foreignNetworkOk=false;if(CS.getNetworkDismissed())return;const e=document.getElementById('network-status');if(e){e.textContent='网络不可用';e.style.display='block';e.style.cssText='padding:8px 16px;background:var(--danger);color:#fff;text-align:center;font-size:12px;cursor:pointer';e.onclick=()=>{CS.setNetworkDismissed(true);e.style.display='none'}}}catch{/* 网络检测 IPC 不可用 → 静默降级 */}}
export function clientTypeTag(t){var m={};m.agent=lucide('globe',12)+' 代理';m.direct=lucide('building',12)+' 直客';m.unlabeled='';m.no_company='<span class="ctype-tag" style="background:#fce4ec;color:#c62828;font-size:10px;padding:1px 6px;border-radius:8px;display:inline-flex;align-items:center;gap:2px">'+lucide('building',10)+' 无公司</span>';m.no_email='<span class="ctype-tag" style="background:#fff3e0;color:#e65100;font-size:10px;padding:1px 6px;border-radius:8px;display:inline-flex;align-items:center;gap:2px">'+lucide('mail',10)+' 无邮箱</span>';m.invalid_email='<span class="ctype-tag" style="background:#fce4ec;color:#c62828;font-size:10px;padding:1px 6px;border-radius:8px;display:inline-flex;align-items:center;gap:2px">'+lucide('alert-circle',10)+' 异常邮箱</span>';m.agent='<span class="ctype-tag ctype-agent">'+m.agent+'</span>';m.direct='<span class="ctype-tag ctype-direct">'+m.direct+'</span>';return m[t]||''}
export function groupByCompany(data){const g={};for(const c of data){const k=c.company||'未命名';if(!g[k])g[k]=[];g[k].push(c)}return Object.entries(g).sort((a,b)=>a[0].localeCompare(b[0]))}

// ── 发送队列入队前过滤 ──────────────────────────────────────────────────
// 统一入口：所有入队路径（手动/背调/月度报告/自动发送）必须经过此判定

/** 禁止发送的 _status 值（中英文） */
const SKIP_STATUSES = new Set(['reached','replied','autoreply']);

/** 禁止发送的 tags 值 */
const SKIP_TAGS = new Set(['reached']);

/** 跳过原因 → 中文展示标签 */
const SKIP_LABEL = {
  noEmail: '无邮箱', bounced: '已退信',
  'status:reached': '已触达', 'status:replied': '有回复', 'status:autoreply': '自动回复',
  'tags:reached': '标签:已触达',
};

/**
 * 判定单个联系人是否可发送。
 * @param {object} c - 联系人对象（含 email, bounced, bounceType, _status, tags）
 * @returns {{ ok: boolean, reason?: string }}
 */
export function isContactSendable(c) {
  if (!c.email || !c.email.includes('@') || c.email.endsWith('@no.email'))
    return { ok: false, reason: 'noEmail' };
  if (c.bounced && c.bounceType !== 'temporary')
    return { ok: false, reason: 'bounced' };
  if (c._status && SKIP_STATUSES.has(c._status))
    return { ok: false, reason: 'status:' + c._status };
  if ((c.tags || []).some(t => SKIP_TAGS.has(t))) {
    const hit = (c.tags || []).find(t => SKIP_TAGS.has(t));
    return { ok: false, reason: 'tags:' + hit };
  }
  return { ok: true };
}

/**
 * 批量过滤联系人 → 可发送列表 + 跳过分组。
 * @param {object[]} members
 * @returns {{ sendable: object[], skipped: Map<string, object[]> }}
 *   skipped key = reason（如 "status:有回复"），value = 被跳过的联系人数组
 */
export function filterSendableContacts(members) {
  const sendable = [];
  const skipped = new Map();
  for (const m of members) {
    const r = isContactSendable(m);
    if (r.ok) { sendable.push(m); continue; }
    const reason = r.reason || 'unknown';
    if (!skipped.has(reason)) skipped.set(reason, []);
    skipped.get(reason).push(m);
  }
  return { sendable, skipped };
}

/**
 * 渲染跳过明细 HTML（用于 toast / alert / modal）。
 * @param {Map<string, object[]>} skipped - filterSendableContacts 返回的 skipped
 * @param {number} maxPerGroup - 每组最多显示的邮箱数，超出折叠（默认 3）
 * @returns {string} HTML 片段
 */
export function renderSkipDetail(skipped, maxPerGroup) {
  if (!skipped || !skipped.size) return '';
  const maxN = maxPerGroup || 3;
  let html = '';
  for (const [reason, contacts] of skipped) {
    const label = SKIP_LABEL[reason] || reason;
    const total = contacts.length;
    const show = contacts.slice(0, maxN);
    html += '<div style="margin-bottom:6px;font-size:12px;line-height:1.6">' +
      '<span style="font-weight:600;color:var(--text)">' + label + ' (' + total + '人)</span>' +
      '<div style="padding-left:8px;color:var(--text-secondary);word-break:break-all">' +
      show.map(c => '· ' + escapeHtml(c.email || '')).join('<br>') +
      '</div>';
    if (total > maxN) {
      html += '<span style="font-size:10px;color:var(--text-secondary);padding-left:8px">▸ 及其他 ' + (total - maxN) + ' 人...</span>';
    }
    html += '</div>';
  }
  // 跳过明细容器：限定最大高度，超出滚动
  return '<div style="text-align:left;max-height:220px;overflow-y:auto;margin-top:8px;padding:8px;background:var(--bg);border-radius:6px;border:1px solid var(--border)">' + html + '</div>';
}
window.addEventListener('error',(e)=>{const m=`JS错误: ${e.message} (${e.filename}:${e.lineno})`;console.error(m,e.error);const b=document.createElement('div');b.style.cssText='position:fixed;top:0;left:0;right:0;background:#f44336;color:#fff;padding:8px 16px;font-size:12px;z-index:99999';b.textContent=m;document.body.prepend(b)});
window.__pageHandlers['dashboard'] = async () => { await loadDashboard(); try { const { syncCards } = await import('./dashboard-editor.js'); syncCards(); } catch { /* 渲染层降级：操作失败不影响 UI */ } };
