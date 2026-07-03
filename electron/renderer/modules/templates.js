const S = window.S;
import { lucide,escapeHtml,showToast,showAlert,showConfirm,countryToLang } from './shared.js';
import { saveQueue, renderQueue } from './send-queue.js';

export function matchUserTemplates(templates, type, stage, lang) {
  if (!templates?.length) return [];
  // 精确匹配 + general 兜底
  return templates.filter(t =>
    (t.type === type || t.type === 'general') &&
    (t.stage === stage || t.stage === 'general') &&
    (t.lang === lang || t.lang === 'general')
  );
}

export function randomPick(type, stage, usedSentences) {
  if (!S.templateLib) return {};
  const usedSet = new Set(usedSentences || []);

  // 从数组随机选取，支持已用排除 + 可选过滤
  const pickFrom = (arr, filterFn) => {
    if (!arr || !arr.length) return null;
    let pool = arr.filter(item => !usedSet.has(item.id));
    if (pool.length === 0) pool = [...arr];
    if (filterFn && pool.some(filterFn)) pool = pool.filter(filterFn);
    if (pool.length === 0) pool = arr.filter(item => !usedSet.has(item.id));
    if (pool.length === 0) pool = [...arr];
    return pool[Math.floor(Math.random() * pool.length)];
  };

  // 取值：支持按类型拆分的对象 {agent:[], direct:[], unlabeled:[]} 或旧版数组
  const getPool = (key) => {
    const v = S.templateLib[key];
    if (!v) return [];
    if (Array.isArray(v)) return v;
    return v[type] || Object.values(v)[0] || [];
  };

  // CTA：阶段策略驱动
  const pickCTA = () => {
    const src = getPool('ctas');
    if (stage === 'f3' || stage === 'f4') return pickFrom(src, item => item.id.endsWith('4')) || pickFrom(src);
    if (stage === 'f2') return pickFrom(src, item => item.id.endsWith('3')) || pickFrom(src);
    return pickFrom(src);
  };

  // F3/F4 不用 Hook/Pain，F4 不用 Proof
  const skipHook = (stage === 'f3' || stage === 'f4');
  const skipPain = (stage === 'f3' || stage === 'f4');
  const skipProof = (stage === 'f4');

  // Proof 阶段策略：F3 只用简洁版（编号以 4 结尾），冷开发/F1/F2 任意
  const pickProof = () => {
    if (stage === 'f3') return pickFrom(S.templateLib.proofs?.[type], item => item.id.endsWith('4'));
    return pickFrom(S.templateLib.proofs?.[type]);
  };

  return {
    hook: skipHook ? null : pickFrom(getPool('hooks')),
    pain: skipPain ? null : pickFrom(S.templateLib.painPoints?.[type]),
    proof: skipProof ? null : pickProof(),
    cta: pickCTA(),
    followup: (stage !== 'cold' && stage !== 'archived') ? pickFrom(S.templateLib.followUps?.[stage]) : null,
  };
}

// ponytail: addToQueue 已迁移至 send-compose.js，send 页面事件监听器同理

export function breathingRoomText(lang, type) {
  // 3种变体，和布局变体联动
  const all = {
    agent: [
      {es:'Si alguna vez tu capacidad actual se queda corta — o simplemente quieres comparar opciones — tener un respaldo cuesta cero y puede ahorrar muchos dolores de cabeza.',pt:'Se alguma vez sua capacidade atual ficar limitada — ou simplesmente quiser comparar opções — ter um respaldo não custa nada e pode evitar muitas dores de cabeça.',en:"If your current capacity ever falls short — or you simply want to compare options — having backup costs nothing and can save you plenty of headaches."},
      {es:'No hay compromiso — solo quería que supieras que existe esta alternativa por si algún día la necesitas.',pt:'Não há compromisso — só queria que você soubesse que esta alternativa existe, caso algum dia precise.',en:"No strings — just wanted you to know this alternative exists in case you ever need it."},
      {es:'Tener una opción más en la manga nunca está de más en este negocio. Sin compromiso, sin costo.',pt:'Ter mais uma opção na manga nunca é demais neste negócio. Sem compromisso, sem custo.',en:"Having one more option up your sleeve never hurts in this business. No strings, no cost."},
    ],
    direct: [
      {es:'Si alguna vez tu operación actual enfrenta una demora o un imprevisto en aduana, contar con una alternativa probada puede ahorrarte semanas y costos inesperados.',pt:'Se alguma vez sua operação atual enfrentar um atraso ou imprevisto na alfândega, contar com uma alternativa comprovada pode economizar semanas e custos inesperados.',en:'If your current operation ever hits a customs delay or an unexpected snag, having a proven alternative can save you weeks and unplanned costs.'},
      {es:'Sin compromiso — solo quería que tuvieras esta opción en cuenta para cuando la necesites.',pt:'Sem compromisso — só queria que você tivesse esta opção em conta para quando precisar.',en:"No strings — just wanted you to have this option in mind for when you need it."},
      {es:'En comercio exterior, un plan B no es un lujo — es sentido común. Sin compromiso, sin costo.',pt:'No comércio exterior, um plano B não é luxo — é bom senso. Sem compromisso, sem custo.',en:"In foreign trade, a plan B isn't a luxury — it's common sense. No strings, no cost."},
    ],
    unlabeled: [
      {es:'Si alguna vez necesitas apoyo logístico o simplemente quieres explorar alternativas, estoy a tu disposición.',pt:'Se alguma vez você precisar de apoio logístico ou simplesmente quiser explorar alternativas, estou à sua disposição.',en:"If you ever need logistics support or simply want to explore alternatives, I'm at your disposal."},
      {es:'Sin ningún compromiso — solo quería presentarme y que sepas que existo como recurso.',pt:'Sem nenhum compromisso — só queria me apresentar e que você saiba que existo como recurso.',en:"No strings at all — just wanted to introduce myself so you know I exist as a resource."},
      {es:'No está de más tener un contacto logístico adicional. Sin compromiso, sin prisa.',pt:'Não custa nada ter um contato logístico adicional. Sem compromisso, sem pressa.',en:"It doesn't hurt to have an extra logistics contact. No strings, no rush."},
    ],
  };
  const list = all[type] || all.unlabeled;
  return (list[Math.floor(Math.random() * 3)])[lang] || '';
}

export function f4ClosingText(lang, type) {
  const map = {
    agent: {
      es: 'Si en el futuro necesitas respaldo de espacio o comparar opciones de naviera, aquí me tienes. Sin compromiso, sin prisa.',
      pt: 'Se no futuro você precisar de respaldo de espaço ou comparar opções de armador, estou aqui. Sem compromisso, sem pressa.',
      en: "If in the future you need space backup or want to compare carrier options, I'm here. No strings, no rush.",
    },
    direct: {
      es: 'Si en el futuro tu operación aduanal necesita un respaldo confiable, aquí me tienes. Sin compromiso, sin prisa.',
      pt: 'Se no futuro sua operação aduaneira precisar de um respaldo confiável, estou aqui. Sem compromisso, sem pressa.',
      en: "If in the future your customs operation needs reliable backup, I'm here. No strings, no rush.",
    },
    unlabeled: {
      es: 'Si en el futuro necesitas explorar opciones logísticas, aquí me tienes. Sin compromiso, sin prisa.',
      pt: 'Se no futuro você quiser explorar opções logísticas, estou aqui. Sem compromisso, sem pressa.',
      en: "If in the future you want to explore logistics options, I'm here. No strings, no rush.",
    },
  };
  return (map[type] || map.unlabeled)[lang] || '';
}

export function f4FollowupText(lang, type) {
  const map = {
    agent: {
      es: 'Mientras tanto, de vez en cuando te compartiré alguna información de mercado que pueda ser útil para tu operación.',
      pt: 'Enquanto isso, de vez em quando compartilharei informações de mercado que possam ser úteis para sua operação.',
      en: "In the meantime, I'll occasionally share market insights that might be useful for your operation.",
    },
    direct: {
      es: 'Mientras tanto, te compartiré ocasionalmente información de mercado que pueda ser relevante para tus importaciones.',
      pt: 'Enquanto isso, compartilharei ocasionalmente informações de mercado que possam ser relevantes para suas importações.',
      en: "In the meantime, I'll occasionally share market insights that might be relevant to your imports.",
    },
    unlabeled: {
      es: 'Te compartiré de vez en cuando información del mercado que pueda resultarte útil.',
      pt: 'Compartilharei de vez em quando informações do mercado que possam ser úteis para você.',
      en: "I'll occasionally share market insights that might be useful to you.",
    },
  };
  return (map[type] || map.unlabeled)[lang] || '';
}

export function assembleEmail(lang, hook, pain, proof, cta, followup, stage, type, senderName, firstName) {
  const t = (item) => item ? (item[lang] || '') : '';
  // Phase 3: 有 firstName 时个性化问候
  const greeting = firstName
    ? (lang === 'es' ? `Buen día, ${firstName},` : lang === 'pt' ? `Bom dia, ${firstName},` : `Hello, ${firstName},`)
    : (lang === 'es' ? 'Buen día,' : lang === 'pt' ? 'Bom dia,' : 'Hello,');
  const closing = lang === 'es' ? 'Saludos,' : lang === 'pt' ? 'Atenciosamente,' : 'Best,';
  const senderDisplay = senderName || 'YQN';
  const intros = [
    lang === 'es' ? `Soy ${senderDisplay}, de YQN.` : lang === 'pt' ? `Sou ${senderDisplay}, da YQN.` : `I'm ${senderDisplay} from YQN.`,
    lang === 'es' ? `Me presento: ${senderDisplay}, de YQN.` : lang === 'pt' ? `Me apresento: ${senderDisplay}, da YQN.` : `Let me introduce myself: ${senderDisplay} from YQN.`,
    lang === 'es' ? `Mi nombre es ${senderDisplay} y formo parte de YQN.` : lang === 'pt' ? `Meu nome é ${senderDisplay} e faço parte da YQN.` : `My name is ${senderDisplay} and I'm part of YQN.`,
  ];
  const h = t(hook), p = t(pain), r = t(proof), c = t(cta), f = t(followup);

  // ── 布局变体（3套，随机选）─────────────────────────────────────
  const idx = Math.floor(Math.random() * 3);
  const intro = intros[idx];
  const breath = breathingRoomText(lang, type);

  if (stage === 'cold') {
    return [
      // A: hook → pain → intro+proof → breath → cta
      [greeting,'',h,'',p,'',intro+' '+r,'',breath,'',c,'',closing].join('\n'),
      // B: hook → intro → pain+proof → breath → cta
      [greeting,'',h,'',intro,'',p+' '+r,'',breath,'',c,'',closing].join('\n'),
      // C: pain前置 → hook → intro+proof → 直接cta（去呼吸句，更短）
      [greeting,'',p,'',h,'',intro+' '+r,'',c,'',closing].join('\n'),
    ][idx];
  }

  if (stage === 'f1' || stage === 'f2') {
    return [
      // A: followup → hook → pain → intro+proof → cta
      [greeting,'',f,'',h,'',p,'',intro+' '+r,'',c,'',closing].join('\n'),
      // B: followup → pain → intro+proof → hook → cta
      [greeting,'',f,'',p,'',intro+' '+r,'',h,'',c,'',closing].join('\n'),
      // C: followup → hook → intro → pain+proof → cta（更紧凑）
      [greeting,'',f,'',h,'',intro,'',p+' '+r,'',c,'',closing].join('\n'),
    ][idx];
  }

  if (stage === 'f3') {
    return [
      // A: followup → proof → cta（极简）
      [greeting,'',f,'',intro+' '+r,'',c,'',closing].join('\n'),
      // B: followup → cta → proof（cta前置）
      [greeting,'',f,'',c,'',intro+' '+r,'',closing].join('\n'),
      // C: followup+c → proof收尾
      [greeting,'',f+' '+c,'',intro+' '+r,'',closing].join('\n'),
    ][idx];
  }

  // F4
  return [
    // A: followup → close → followup → cta
    [greeting,'',f,'',f4ClosingText(lang,type),'',f4FollowupText(lang,type),'',c,'',closing].join('\n'),
    // B: close → followup → cta
    [greeting,'',f4ClosingText(lang,type),'',f,'',f4FollowupText(lang,type),'',c,'',closing].join('\n'),
    // C: close → cta → followup
    [greeting,'',f4ClosingText(lang,type),'',c,'',f4FollowupText(lang,type),'',closing].join('\n'),
  ][idx];
}

// ── 月度报告组装（归档客户维护）──────────────────────────────────────
export function assembleMonthlyReport(lang, hook, marketContext) {
  const t = (item) => item ? (item[lang] || '') : '';
  const lines = [];

  const greeting = lang === 'es' ? 'Buen día,' : lang === 'pt' ? 'Bom dia,' : 'Hello,';
  lines.push(greeting);
  lines.push('');

  // Hook 问候句
  if (hook) {
    lines.push(t(hook));
    lines.push('');
  }

  // 用户填入的市场动态（默认兜底）
  const defaultMarket = {
    es: 'El panorama logístico en las rutas Asia-Latinoamérica sigue evolucionando. Los volúmenes de carga se mantienen activos y las tarifas continúan ajustándose. Como siempre, contar con opciones de respaldo marca la diferencia.',
    pt: 'O panorama logístico nas rotas Ásia-América Latina continua evoluindo. Os volumes de carga seguem ativos e as tarifas continuam se ajustando. Como sempre, contar com opções de respaldo faz a diferença.',
    en: 'The logistics landscape on Asia-Latin America routes keeps evolving. Cargo volumes remain active and rates continue to adjust. As always, having backup options makes the difference.',
  };
  lines.push(marketContext && marketContext.trim() ? marketContext.trim() : defaultMarket[lang] || defaultMarket.en);
  lines.push('');

  // 软关门
  const softClose = {
    es: 'Si en algún momento necesitas apoyo logístico, aquí estoy. Sin compromiso.',
    pt: 'Se em algum momento precisar de apoio logístico, estou aqui. Sem compromisso.',
    en: 'If you ever need logistics support, I\'m here. No strings.',
  };
  lines.push(softClose[lang] || softClose.en);

  // 结语
  lines.push('');
  const closing = lang === 'es' ? 'Saludos,' : lang === 'pt' ? 'Atenciosamente,' : 'Best,';
  lines.push(closing);

  return lines.join('\n');
}

// ── 批量生成月度报告 ─────────────────────────────────────────────────
export async function generateMonthlyReports() {
  const marketEl = document.getElementById('monthly-market-context');
  const marketContext = marketEl?.value || '';
  const archivedCompanies = Object.entries(S.sendCompanies)
    .filter(([name]) => S.sendHistory[name]?.stage === 'archived');

  if (!archivedCompanies.length) {
    await showAlert('没有已归档的公司。');
    return;
  }

  let added = 0;
  for (const [name, members] of archivedCompanies) {
    const emails = members.map(m => m.email).filter(Boolean);
    if (!emails.length) continue;

    const ctype = members[0]?.clientType || 'unlabeled';
    const lang = countryToLang(members[0]?.country || '');
    const hook = randomPick(ctype, 'monthly', []).hook; // 月度报告只要 Hook

    const body = assembleMonthlyReport(lang, hook, marketContext);
    const subjects = {
      agent: { es: 'Panorama logístico — breve actualización', pt: 'Panorama logístico — breve atualização', en: 'Logistics snapshot — quick update' },
      direct: { es: 'Panorama logístico — breve actualización', pt: 'Panorama logístico — breve atualização', en: 'Logistics snapshot — quick update' },
      unlabeled: { es: 'Panorama logístico — breve actualización', pt: 'Panorama logístico — breve atualização', en: 'Logistics snapshot — quick update' },
    };
    const subject = subjects[ctype]?.[lang] || subjects.unlabeled[lang];

    S.queue.push({
      id: Date.now() + added,
      company: name,
      to: emails.join(', '),
      recipients: emails,
      subject,
      body,
      status: 'pending',
      addedAt: new Date().toISOString(),
      _stage: 'monthly', _type: ctype, _lang: lang,
      _recipientStatus: emails.map(e => ({ email: e, status: 'pending' })),
    });
    added++;
  }

  if (!added) { await showAlert('归档公司无有效邮箱。'); return; }

  saveQueue();
  document.getElementById('stat-queue').textContent = S.queue.length;
  await showAlert(`已生成 ${added} 封月度报告，已加入发送队列。`);
  renderQueue();
  // 跳转到发送队列
  const queueNav = document.querySelector('[data-page="queue"]');
  if (queueNav) queueNav.click();
}
