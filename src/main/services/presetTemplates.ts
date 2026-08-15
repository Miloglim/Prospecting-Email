// ── 内置预设模板库 v2 ──────────────────────────────────────
// 3 客户类型 × 5 阶段 × 2 变体 = 30 套，发送引擎自动匹配
// 语法：
//   {{firstName}} {{company}} {{title}}  — 联系人变量
//   {optionA|optionB|optionC}            — 随机词，每次渲染随机选一个（反限流核心）
//   {Hello|Hi|Hey}                       — 短词随机
//   {我们提供A|我们专注B|我们擅长C}       — 短语随机

export interface PresetTemplate {
  name: string;
  category: string;  // direct / peer / general — 按联系人 clientType 自动匹配
  stage: string;     // initial / followup1 / followup2 / closing / reactivate
  variant: string;   // a / b — 同 category+stage 的多套变体
  language: string;
  subject: string;
  body: string;
}

export const PRESET_TEMPLATES: PresetTemplate[] = [
  // ══════════════════════════════════════════════════════════
  // 直客（direct）— 已明确有货运需求的终端客户
  // ══════════════════════════════════════════════════════════

  // ── initial / variant a: 问题切入型 ──
  {
    name: "Direct · 初次 A", category: "direct", stage: "initial", variant: "a", language: "EN",
    subject: "{{firstName}}, {quick question|one thought} on {{company}}'s LATAM freight",
    body: "{Hi|Hello} {{firstName}},\n\nI've been {looking at|reviewing} {{company}}'s operations and noticed you're moving {significant|cargo} volume through Latin America.\n\nMost shippers on this lane deal with three {pain points|headaches}: {unpredictable|inconsistent} transit times, rate {spikes|surges} during peak season, and limited visibility once cargo leaves port.\n\nWe {tackle|solve} all three — fixed weekly allocations, {capped|locked} contract rates, and real-time tracking from {origin|departure} to delivery.\n\n{Worth a 10-minute call this week?|Would it make sense to compare notes?|Happy to share a sample lane quote if you'd like.}\n\n{Best regards|Cheers|Talk soon}",
  },
  // ── initial / variant b: 价值主张型 ──
  {
    name: "Direct · 初次 B", category: "direct", stage: "initial", variant: "b", language: "EN",
    subject: "{{company}} → LATAM: {a better way|another option}",
    body: "{Good morning|Good day} {{firstName}},\n\nIf you're {handling|managing} {{company}}'s ocean freight and want to {benchmark|compare} what you're paying now against the market — we should talk.\n\nWe run a {dedicated|focused} Asia → LATAM desk with:\n• {Weekly|Regular} sailings to all major {ports|destinations} — Santos, Manzanillo, Callao, Buenaventura\n• Rates {consistently|typically} 8–15% below {market average|what most forwarders quote}\n• One {point of contact|person} from booking to delivery — no {handoffs|passing you around}\n\n{No commitment needed — just a comparison quote.|Happy to price-check one of your current lanes, no strings attached.}\n\n{Regards|Best|Sincerely}",
  },

  // ── followup1 / variant a: 软跟进 ──
  {
    name: "Direct · 跟进1 A", category: "direct", stage: "followup1", variant: "a", language: "EN",
    subject: "{Re: |} {{firstName}}, following up {briefly|quickly}",
    body: "{Hi|Hey} {{firstName}},\n\nI {sent|dropped} a note last week and wanted to make sure it didn't get {buried|lost} in your inbox.\n\n{The short version:|In a nutshell:|TL;DR —} we help importers on the Asia → LATAM lane {cut|reduce} freight costs while getting more {reliable|predictable} transit times. Our clients {typically|usually} save 10–15% on their {current|existing} rates.\n\n{If the timing isn't right, no problem at all.|Happy to wait if you're busy — just wanted to keep this on your radar.}\n\n{Cheers|Best}",
  },
  // ── followup1 / variant b: 新信息角度 ──
  {
    name: "Direct · 跟进1 B", category: "direct", stage: "followup1", variant: "b", language: "EN",
    subject: "{{firstName}}, one {data point|stat} that might {interest|surprise} you",
    body: "{{firstName}},\n\nFollowing up with something {concrete|specific} — last month we moved 47 containers Santos-bound for a client {similar to|about the size of} {{company}}, and their landed cost dropped {11%|nearly 12%} versus their previous forwarder.\n\nSame lane, same carriers — {better negotiated allocation|stronger volume leverage}.\n\nI'm not saying we'll hit the exact same number for {{company}}, but we can get {close|within range}. {Worth a 5-minute comparison?|Want me to run the numbers for one of your lanes?}\n\n{Best|Regards}",
  },

  // ── followup2 / variant a: 轻触 ──
  {
    name: "Direct · 跟进2 A", category: "direct", stage: "followup2", variant: "a", language: "EN",
    subject: "{{firstName}} — {closing the loop|last note}",
    body: "{Hi|Hey} {{firstName}},\n\nI'll keep this {short|brief} — I know you're busy.\n\nIf {{company}}'s freight costs or transit times come up in your next team meeting, I'd {love|be happy} to be the one who {brings|sends} a comparison quote to the table.\n\n{If it's not a priority right now, totally understand.|No worries at all if this isn't the right time.}\n\n{Either way, wishing you and the {{company}} team continued success.|I'll leave it here — the door's open whenever you need us.}\n\n{All the best|Take care}",
  },
  // ── followup2 / variant b: 模式打破 ──
  {
    name: "Direct · 跟进2 B", category: "direct", stage: "followup2", variant: "b", language: "EN",
    subject: "{{firstName}}, {honest question|real talk}",
    body: "{{firstName}},\n\n{Totally fair if now's not the right time — I get it.|If I'm barking up the wrong tree, just say the word.}\n\nBut on the {off chance|slight chance} {{company}} is still {paying too much|overpaying} on LATAM ocean freight, I'd {hate|regret} not at least showing you what's possible.\n\nOne lane. One quote. No pitch. If it's useful, you keep it. If not, I {disappear|go away}.\n\n{Fair enough?|Deal?}\n\n{Cheers|— sent from my phone}",
  },

  // ── closing / variant a: 降低门槛 ──
  {
    name: "Direct · 促单 A", category: "direct", stage: "closing", variant: "a", language: "EN",
    subject: "{{firstName}}, {ready when you are|let's make this easy}",
    body: "{Hi|Hello} {{firstName}},\n\nWe've covered a lot so let me {simplify|summarize}:\n\n✅ {Competitive|Sharp} rates on Asia → LATAM — Santos, Manzanillo, Callao, Buenaventura\n✅ Weekly {sailings|departures} with {reliable|consistent} transit times\n✅ {One contact|One person} from booking through {delivery|final mile}\n\nIf you're {open to it|ready}, send me one lane detail and I'll have a quote back within {24|24–48} hours. No {pressure|obligation} — we either {save you money|improve your service} or we don't.\n\n{Best regards|Looking forward}",
  },
  // ── closing / variant b: 紧迫感 ──
  {
    name: "Direct · 促单 B", category: "direct", stage: "closing", variant: "b", language: "EN",
    subject: "{{firstName}} — {before rates shift|while space holds}",
    body: "{{firstName}},\n\n{Quick heads-up:|Just a note —} our Q4 Asia → LATAM allocation is filling up, and rates typically {tick up|climb} 5–8% once peak season {hits|kicks in}.\n\nIf {{company}} has any shipments in the pipeline for the next {60–90 days|quarter}, locking in now {beats|avoids} the rush.\n\n{Want me to reserve tentative space?|Even a soft forecast helps — I can hold provisional allocation.}\n\n{Best|Talk soon}",
  },

  // ── reactivate / variant a: 变化驱动 ──
  {
    name: "Direct · 激活 A", category: "direct", stage: "reactivate", variant: "a", language: "EN",
    subject: "{{firstName}}, {checking in|touching base} — anything {changed|shifted}?",
    body: "{Hi|Hey} {{firstName}},\n\nIt's been a {while|few months} since we last {spoke|connected}. Hope {{company}} has been {thriving|doing well}.\n\nSince then we've {expanded|added} our capacity on Asia → LATAM, {improved|tightened} our transit times on several lanes, and brought on {a couple of new carrier partners|additional slot allocations}.\n\nIf your shipping {situation|needs} have evolved — or if you're simply {curious|wondering} what current rates look like — I'm happy to {refresh|update} the quote.\n\n{Either way, good to reconnect.|No pressure — just wanted to say hi.}\n\n{Best|Warm regards}",
  },
  // ── reactivate / variant b: 市场更新 ──
  {
    name: "Direct · 激活 B", category: "direct", stage: "reactivate", variant: "b", language: "EN",
    subject: "{{firstName}} — LATAM freight rates {just dropped|are shifting}",
    body: "{{firstName}},\n\n{Not sure if you're still tracking {{company}}'s freight costs, but|Thought you might want to know —} Asia → LATAM spot rates have {softened|come down} {noticeably|a fair bit} in the past {month|few weeks}.\n\nIf {{company}} has {any volume|shipments} on this lane, now's actually a {pretty good|strong} window to lock in {favorable|competitive} contract terms before the market {rebounds|tightens back up}.\n\n{Want a current market snapshot for your lanes?|Happy to run updated numbers — no strings.}\n\n{Talk soon|Cheers}",
  },

  // ══════════════════════════════════════════════════════════
  // 同行（peer）— 货运代理/物流同行，互为备选
  // ══════════════════════════════════════════════════════════

  // ── initial / variant a: 互补合作 ──
  {
    name: "Peer · 初次 A", category: "peer", stage: "initial", variant: "a", language: "EN",
    subject: "{{firstName}} — {potential synergy|working together} on LATAM lanes",
    body: "{Hi|Hello} {{firstName}},\n\nI run a {freight desk|forwarding operation} focused on Latin America and {came across|found} {{company}} while {researching|looking into} partners on the lane.\n\nAs a fellow forwarder, you {probably|likely} run into situations where you need {extra capacity|a backup option} or better rates on a {specific|particular} route. That's where we {fit in|come in}.\n\nOur model is {simple|straightforward}: you keep the client relationship, we handle the {shipping leg|ocean freight} when you need us. We {win|succeed} when you {win|succeed}.\n\n{Interested in exchanging rate sheets?|Worth a quick call to see if the lanes overlap?}\n\n{Best regards|Looking forward}",
  },
  // ── initial / variant b: 直截了当 ──
  {
    name: "Peer · 初次 B", category: "peer", stage: "initial", variant: "b", language: "EN",
    subject: "{{firstName}}, {we should talk|let's connect}",
    body: "{{firstName}},\n\n{Here's the deal:|Straight to the point —} we're a LATAM-focused freight desk and we're looking to {expand|build out} our partner network.\n\nIf {{company}} moves cargo to/from Brazil, Mexico, Peru, or Colombia — we can {likely|probably} offer you a better {buy rate|cost base} than what you're getting today, especially on {FCL|full container} shipments.\n\n{No exclusivity, no minimums — just a rate advantage when you need it.|You use us when it makes sense, ignore us when it doesn't.}\n\n{Want to test us on one lane?|Send me a lane and I'll send you a number — no commitment.}\n\n{Cheers|Talk soon}",
  },

  // ── followup1 / variant a ──
  {
    name: "Peer · 跟进1 A", category: "peer", stage: "followup1", variant: "a", language: "EN",
    subject: "Re: {{firstName}} — {just circling back|following up}",
    body: "{Hi|Hey} {{firstName}},\n\n{Just bumping this up —|Following up on my note about partnering with {{company}} —} I know these conversations can {take time|simmer}, no rush at all.\n\nTo {put a number on it:|make it concrete —} on our last 200 containers Santos-bound, our average landed cost was {roughly|about} $X/container below {what most forwarders quote|market benchmarks} for the same service level.\n\nIf {{company}} ever has a lane where margins are {tight|thin}, we'd {love|be happy} to be your {go-to fallback|backup option}.\n\n{Cheers|Best}",
  },
  // ── followup1 / variant b ──
  {
    name: "Peer · 跟进1 B", category: "peer", stage: "followup1", variant: "b", language: "EN",
    subject: "{{firstName}}, {one thing I forgot to mention|a quick thought}",
    body: "{{firstName}},\n\n{Quick follow-up — I realized I didn't mention:|Adding to my last email —} we also handle {breakbulk|project cargo} and {special equipment|reefer containers} on the LATAM lane, which is where a lot of forwarders {struggle|get squeezed} on pricing.\n\nIf {{company}} has any {non-standard|specialized} shipments in the {pipeline|works}, we can {probably help|likely beat} whatever rate you're seeing.\n\n{Just putting it out there.|No pressure — just another tool in your kit if needed.}\n\n{Best|Cheers}",
  },

  // ── followup2 / variant a ──
  {
    name: "Peer · 跟进2 A", category: "peer", stage: "followup2", variant: "a", language: "EN",
    subject: "{{firstName}} — {short one|last ping}",
    body: "{Hey|Hi} {{firstName}},\n\n{I promise I'll leave you alone after this.|Last one from me — promise.}\n\nI {genuinely|honestly} think there's a {solid|good} fit here. We're {lean|small} enough to care about every {shipment|booking}, but {connected|positioned} enough to get rates that {compete|hold up}.\n\nIf {{company}} wants a backup lane on LATAM — even just as a {safety net|contingency} — I'm {here|one message away}.\n\n{Take care|All the best}",
  },
  // ── followup2 / variant b ──
  {
    name: "Peer · 跟进2 B", category: "peer", stage: "followup2", variant: "b", language: "EN",
    subject: "{{firstName}}, {your thoughts?|am I off base?}",
    body: "{{firstName}},\n\n{Maybe this isn't the right time, or maybe I've got the wrong angle — totally possible.|If this doesn't align with how {{company}} operates, no hard feelings at all.}\n\nBut if the idea of a {no-strings-attached|zero-commitment} backup partner on LATAM is {even vaguely interesting|at least worth a conversation}, let me know. One 10-minute call, and we'll know if it's a fit.\n\n{Worst case, you lose 10 minutes. Best case, you gain a rate advantage.|If not, I'll stop reaching out. Fair?}\n\n{Cheers|—sent from my phone}",
  },

  // ── closing / variant a ──
  {
    name: "Peer · 促单 A", category: "peer", stage: "closing", variant: "a", language: "EN",
    subject: "{{firstName}} — {let's test it|prove it works}",
    body: "{{firstName}},\n\n{Here's my proposal —|Let me make this concrete —} send us one lane that {{company}} runs regularly. We'll quote it. If we {beat|match} your current cost, you {try us|give us a shot}. If we don't, we {shake hands and move on|part friends}.\n\nNo minimum volume. No exclusivity. No {catch|fine print}.\n\n{That's it. That's the whole pitch.|Simple enough?}\n\n{Ready when you are|Looking forward}",
  },
  // ── closing / variant b ──
  {
    name: "Peer · 促单 B", category: "peer", stage: "closing", variant: "b", language: "EN",
    subject: "{{firstName}} — {one shipment|just one trial}",
    body: "{Hi|Hey} {{firstName}},\n\nLet's {cut through the noise|skip the back-and-forth}. I'm {confident|certain} we can add value to {{company}}'s LATAM operations — {otherwise I wouldn't still be here|or I'd have stopped emailing weeks ago}.\n\n{Here's what I suggest:|My suggestion —} pick {your toughest lane|the route where margins hurt most}. Give us {one shot|one booking}. If we deliver, you've got a {reliable backup|competitive edge}. If we {drop the ball|don't}, you never hear from us again.\n\n{Deal?|Fair enough?}\n\n{Best}",
  },

  // ── reactivate / variant a ──
  {
    name: "Peer · 激活 A", category: "peer", stage: "reactivate", variant: "a", language: "EN",
    subject: "{{firstName}} — {new capacity|more options} on LATAM",
    body: "{Hi|Hey} {{firstName}},\n\nIt's been a {while|minute}. Hope business at {{company}} has been {solid|good}.\n\nWe've {expanded|grown} our carrier {network|relationships} since we last {spoke|connected}, which means {better rates|more competitive pricing} and more {slot availability|booking flexibility} on the LATAM lane.\n\nIf {{company}}'s needs have {changed|evolved} — or if you're simply {curious|wondering} what our current rates look like — {I'm all ears|let's talk}.\n\n{Cheers|Warm regards}",
  },
  // ── reactivate / variant b ──
  {
    name: "Peer · 激活 B", category: "peer", stage: "reactivate", variant: "b", language: "EN",
    subject: "{{firstName}}, {checking in|a quick hello}",
    body: "{{firstName}},\n\n{No agenda here —|Just a friendly check-in —} we {crossed paths|connected} a while back about LATAM freight and I wanted to see how {{company}} is doing.\n\n{The market has been interesting lately, to say the least.|Rates have been all over the place — I'm sure you've noticed.} If {{company}} ever needs {a second opinion|a rate sanity-check} on a LATAM quote, {consider me a free resource|I'm happy to help}.\n\n{Stay well|Take care}",
  },

  // ══════════════════════════════════════════════════════════
  // 通用（general）— 未分类客户 / clientType 为空
  // ══════════════════════════════════════════════════════════

  // ── initial / variant a: 探索型 ──
  {
    name: "General · 初次 A", category: "general", stage: "initial", variant: "a", language: "EN",
    subject: "{{firstName}} — {question about|wondering about} {{company}}",
    body: "{Hi|Hello} {{firstName}},\n\n{I'm reaching out because|I wanted to ask —} does {{company}} currently {import from or export to|ship to/from} Latin America?\n\nIf so, we {might be able to|can likely} help. We're a {specialized|focused} freight desk covering Asia → LATAM and US → LATAM, and our clients {typically|usually} see {meaningful|real} savings versus {what they were paying before|their previous forwarders}.\n\nIf not — {no worries at all, and apologies for the noise.|totally understand — disregard this.}\n\n{Would a quick call make sense, or should I leave you alone?|Either way, wishing you continued success.}\n\n{Best|Regards}",
  },
  // ── initial / variant b: 问题驱动 ──
  {
    name: "General · 初次 B", category: "general", stage: "initial", variant: "b", language: "EN",
    subject: "{{firstName}}, {quick question|curious} about {{company}}'s {supply chain|logistics}",
    body: "{{firstName}},\n\n{Not sure if you're the right person for this —|I hope I'm reaching the right person —} I wanted to {ask about|learn more about} how {{company}} handles ocean freight to/from Latin America.\n\nIf you're {involved in|close to} those decisions: we help companies {like yours|similar to {{company}}} move cargo more {efficiently|cost-effectively} on this lane. The typical result is {lower costs|better rates} and fewer {headaches|surprises}.\n\n{If I'm way off base, my apologies — and feel free to point me in the right direction.|If this isn't in your wheelhouse, I'd appreciate being pointed to the right contact.}\n\n{Thanks for reading|Appreciate your time}",
  },

  // ── followup1 / variant a ──
  {
    name: "General · 跟进1 A", category: "general", stage: "followup1", variant: "a", language: "EN",
    subject: "Re: {{firstName}} — {just following up|didn't want to get lost}",
    body: "{Hi|Hey} {{firstName}},\n\n{Not sure if my last email reached you —|Following up in case my previous message got buried —} I {touched on|mentioned} how we help {companies|businesses} on the LATAM freight lane save on costs and {improve|tighten} transit reliability.\n\n{To give you a concrete example:|For context —} one of our clients {reduced|cut} their Santos-bound freight costs by about {13%|12–14%} in their first quarter with us, without changing carriers — {just better volume leverage|purely through consolidated buying power}.\n\n{If {{company}} ships to LATAM, I'd love to share what that might look like for you.|No pressure — just wanted to put a number to the conversation.}\n\n{Cheers|Best}",
  },
  // ── followup1 / variant b ──
  {
    name: "General · 跟进1 B", category: "general", stage: "followup1", variant: "b", language: "EN",
    subject: "{{firstName}}, {still thinking about|wanted to add}",
    body: "{{firstName}},\n\n{I realized I should be more specific about who we help — is this useful?|Let me be more specific — I should have led with this.}\n\nWe work with:\n→ Importers bringing {consumer goods|electronics|textiles} from Asia to Brazil, Mexico, Peru\n→ Exporters shipping {commodities|agricultural products|raw materials} from LATAM to Asia\n→ Forwarders who need {reliable|cost-effective} partner carriers on specific lanes\n\nIf {{company}} {fits any of those|matches one of these profiles}, we should {definitely|absolutely} talk.\n\n{Curious?|Worth 10 minutes?}\n\n{Best|Cheers}",
  },

  // ── followup2 / variant a ──
  {
    name: "General · 跟进2 A", category: "general", stage: "followup2", variant: "a", language: "EN",
    subject: "{{firstName}} — {won't keep emailing|last message}",
    body: "{Hi|Hey} {{firstName}},\n\n{This will be my last email — I respect your inbox.|I'll wrap this up here.}\n\nIf {{company}} ships to Latin America {now or in the future|at any point}, we're {here|available} — competitive rates, reliable transit, and one dedicated contact.\n\nIf not — {no harm done, and I genuinely wish you continued success.|totally understand, and I won't take more of your time.}\n\n{Take care|All the best}",
  },
  // ── followup2 / variant b ──
  {
    name: "General · 跟进2 B", category: "general", stage: "followup2", variant: "b", language: "EN",
    subject: "{{firstName}}, {am I in the right place?|one last check}",
    body: "{{firstName}},\n\n{If I'm emailing the wrong person entirely — my sincere apologies.|I suspect I might have the wrong contact — and if so, sorry about that.}\n\nI help {companies|businesses} optimize ocean freight on Asia → LATAM routes. If that's {relevant|useful} to {{company}}, I'd be {happy|glad} to {share more|hop on a call}.\n\nIf not, {a quick 'not interested' is totally fine — I'll update my notes and move on.|just let me know and I'll stop reaching out. No hard feelings.}\n\n{Thanks|Appreciate it}",
  },

  // ── closing / variant a ──
  {
    name: "General · 促单 A", category: "general", stage: "closing", variant: "a", language: "EN",
    subject: "{{firstName}} — {let's find out|let's see} if this {makes sense|is a fit}",
    body: "{Hi|Hello} {{firstName}},\n\n{You've been patient with my emails — thank you.|I appreciate you sticking with this thread.}\n\nOne {simple|quick} way to find out if we can help: send me {one lane detail|an origin-destination pair} that {{company}} runs or is considering. I'll {come back|get back to you} within 24 hours with a {firm|concrete} quote.\n\nIf it's useful — great, you keep it. If not — {we part as friends|no hard feelings} and I'll {stop filling your inbox|leave you in peace}.\n\n{Fair?|Deal?}\n\n{Best regards}",
  },
  // ── closing / variant b ──
  {
    name: "General · 促单 B", category: "general", stage: "closing", variant: "b", language: "EN",
    subject: "{{firstName}}, {maybe this helps|worth a look}",
    body: "{{firstName}},\n\n{Instead of another pitch —|Let me try something different —} here's a {real|actual} case: last quarter, a {mid-sized|growing} importer in {Brazil|São Paulo} switched their Asia freight to us. First shipment, same carrier, same lane — 11% cheaper and {two days|48 hours} faster transit because we had {better slot allocation|priority booking}.\n\nIf {{company}} imports {anything|any volume} from Asia, I'm {fairly|reasonably} sure we can {do the same|replicate that} for you.\n\n{One trial shipment — that's all I'm asking.|Worth testing?}\n\n{Cheers|Talk soon}",
  },

  // ── reactivate / variant a ──
  {
    name: "General · 激活 A", category: "general", stage: "reactivate", variant: "a", language: "EN",
    subject: "{{firstName}} — {been a while|long time no talk}",
    body: "{Hi|Hey} {{firstName}},\n\n{It's been several months since we last connected. Hope all is well at {{company}}.|Time flies — hope you and the {{company}} team are doing great.}\n\nI wanted to {check in|touch base} — if {{company}}'s shipping {situation|needs} have changed, or if LATAM freight is now on your {radar|plate}, we'd {love to|be happy to} pick up the conversation.\n\n{Our capacity and rates have only improved since we last spoke.|We've grown quite a bit — more lanes, better rates, stronger carrier relationships.}\n\n{No pressure — just wanted to say hi.|Either way, good to reconnect.}\n\n{Warm regards|All the best}",
  },
  // ── reactivate / variant b ──
  {
    name: "General · 激活 B", category: "general", stage: "reactivate", variant: "b", language: "EN",
    subject: "{{firstName}}, a {quick market update|small piece of news}",
    body: "{{firstName}},\n\n{Not sure if this is still relevant, but thought you should know:|Sharing this in case it's useful —} ocean freight rates on Asia → LATAM have {shifted|moved} {significantly|noticeably} in the past quarter. If {{company}} has any {exposure|volume} on this lane, now might be a {good|strategic} time to {lock in|secure} favorable terms.\n\n{Happy to discuss over a quick call — or ignore this entirely if it's not relevant.|If this matters to {{company}}, let's talk. If not, disregard — and sorry for the noise.}\n\n{Take care|Best}",
  },
];
