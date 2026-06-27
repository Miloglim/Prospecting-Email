// ── 信号评分引擎（基于开发证据，非关键词）─────────────────────────────────
function autoRate(combined, company) {
  const text = combined.toLowerCase();
  let score = 1;
  const signals = { found: [], missing: [], warn: [] };

  // A 级：招标/RFQ
  const hasRFQ = text.includes('rfq') || text.includes('request for quotation') ||
    text.includes('tender') || text.includes('招标') || text.includes('licitación') ||
    text.includes('bidding') || text.includes('request for proposal');
  if (hasRFQ) { score += 3; signals.found.push('A: 公开招标/RFQ'); }

  // B 级：物流团队扩张
  const hiringKeywords = [
    'logistics specialist', 'logistics manager', 'logistics team leader',
    'supply chain manager', 'supply chain specialist', 'supply chain analyst',
    'customs manager', 'customs compliance', 'customs specialist',
    'trade compliance', 'import/export analyst', 'import export analyst',
    'freight quote', 'customs cost', 'shipping coordinator',
    'transportation manager', 'logistics coordinator', 'procurement specialist',
    'supply chain director', 'logistics director'
  ];
  let hiringCount = 0;
  for (const kw of hiringKeywords) {
    if (text.includes(kw)) hiringCount++;
  }
  if (hiringCount >= 3) {
    score += 3; signals.found.push('B: 多个物流/关务岗位同时招聘（团队扩张）');
  } else if (hiringCount >= 1) {
    score += 2; signals.found.push('B: 物流/关务岗位招聘中');
  }

  // C 级：进口结构
  const shipmentCountMatch = text.match(/(?:import|shipment|贸易|进出口).*?(?:[\d,]+)\s*(?:shipments?|票|笔)/i);
  const shipmentCount = shipmentCountMatch ? parseInt(shipmentCountMatch[0].replace(/[^\d]/g, '')) : 0;
  const importLarge = shipmentCount > 200 || (text.includes('million') && text.match(/\$\s*(\d+)\s*million/i));
  const chinaPctMatch = text.match(/(?:china|chinese|中国).*?(\d{1,3})\s*%/i);
  const chinaDependent = chinaPctMatch && parseInt(chinaPctMatch[1]) > 40;
  const hasChinaTrade =
    (text.includes('china') || text.includes('chinese') || text.includes('ningbo') ||
     text.includes('shanghai') || text.includes('shenzhen') || text.includes('yantian')) &&
    (text.includes('import') || text.includes('shipment') || text.includes('supplier'));

  if (hasChinaTrade && chinaDependent) {
    score += 2; signals.found.push('C: 从中国进口占比>' + chinaPctMatch[1] + '%（高依赖）');
  } else if (hasChinaTrade && importLarge) {
    score += 2; signals.found.push('C: 从中国进口体量大（>' + shipmentCount + '票）');
  } else if (hasChinaTrade) {
    score += 1; signals.found.push('C: 从中国进口贸易记录');
  }

  // D 级：关务复杂度
  const hasCustomsComplexity =
    text.includes('immex') || text.includes(' bonded ') || text.includes('bonded warehouse') ||
    text.includes('oea') || text.includes('authorized economic operator') ||
    text.includes('recinto fiscalizado') || text.includes('recinto fiscal');
  if (hasCustomsComplexity) {
    score += 1; signals.found.push('D: 关务复杂度高（IMMEX/保税/OEA）');
  }

  // E 级：扩张
  const isExpanding =
    text.includes('expansion') || text.includes('new plant') || text.includes('new facility') ||
    text.includes('investment') || text.includes('扩建') || text.includes('产能');
  if (isExpanding) {
    score += 1; signals.found.push('E: 产能/业务扩张中');
  }

  // F 级：决策人可达性
  const hasDecisionMaker =
    text.includes('general manager') || text.includes('country manager') ||
    text.includes('supply chain director') || text.includes('logistics director') ||
    text.includes('procurement director') || text.includes('compras');
  if (hasDecisionMaker) {
    score += 1; signals.found.push('F: 决策人可定位');
  } else {
    signals.warn.push('未定位到物流/采购决策人');
  }

  if (!hiringCount && !hasRFQ) {
    signals.missing.push('未发现物流招聘或招标信号');
  }
  if (!hasChinaTrade) {
    signals.missing.push('未发现从中国进口贸易记录');
  }

  // 负向信号
  const hasInternalLogistics =
    (text.includes('internal') && (text.includes('supply chain') || text.includes('logistics'))) ||
    text.includes('self-operated logistics') || text.includes('in-house logistics') ||
    text.includes('own fleet') || text.includes('自有物流') ||
    text.includes('global logistics network') || text.includes('global supply chain network');

  const fortuneOrGiant =
    (text.includes('fortune 500') || text.includes('fortune global')) &&
    (text.includes('employee') || text.match(/\d{3,}\s*(?:employees|workers|员工)/i));

  if (hasInternalLogistics) {
    score -= 3; signals.missing.push('X: 有内部/自建物流网络');
  }
  if (fortuneOrGiant && !hiringCount && !hasRFQ) {
    score -= 1; signals.warn.push('超大型集团且无物流招聘');
  }

  return { rating: Math.max(1, Math.min(5, score)), signals };
}

module.exports = { autoRate };
