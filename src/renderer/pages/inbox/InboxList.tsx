import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Button, message, Alert, Modal, Tooltip, Progress } from "antd";

// (Button etc. used in sub-components)
import {
  ReloadOutlined, MailOutlined,
  DeleteOutlined,
  ThunderboltOutlined, SaveOutlined,
} from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface InboxItem {
  id: number; fromEmail: string; fromName: string | null;
  subject: string | null; bodyPreview: string | null;
  classification: string | null; matchedContactId: number | null;
  isRead: number; receivedAt: string;
  accountId?: number; messageId?: string | null;
  _accountEmail?: string | null;
  _contactStatus?: string | null;
  _contactTags?: string | null;
}

interface EmailSummary { summary: string; nextStep: string; }

const TYPE: Record<string, { label: string; dot: string }> = {
  replied: { label: "回复", dot: "#22a644" },
  bounce: { label: "退信", dot: "#e5484d" },
  autoreply: { label: "自动回复", dot: "#e6a817" },
  sent: { label: "已发送", dot: "#2563eb" },
  other: { label: "其他", dot: "#8b8b8b" },
};

const FILTERS = [
  { key: "all", label: "全部" },
  { key: "sent", label: "已发送", dot: "#2563eb" },
  { key: "replied", label: "回复", dot: "#22a644" },
  { key: "autoreply", label: "自动回复", dot: "#e6a817" },
  { key: "bounce", label: "退信", dot: "#e5484d" },
  { key: "other", label: "其他", dot: "#8b8b8b" },
];

// ── 未读追踪 ──

function loadViewed(): Set<string> {
  try { const s = localStorage.getItem("inbox-v"); return s ? new Set(JSON.parse(s)) : new Set(); }
  catch { return new Set(); }
}
function saveViewed(s: Set<string>) {
  try { localStorage.setItem("inbox-v", JSON.stringify([...s].slice(-2000))); } catch { /* */ }
}
function mk(m: InboxItem) { return `${m.accountId || ""}|${m.messageId || ""}|${m.fromEmail}|${m.subject || ""}`; }

function shortTime(s: string): string {
  if (!s) return "";
  const d = new Date(s), n = new Date();
  if (n.getTime() - d.getTime() < 864e5 && d.getDate() === n.getDate()) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (n.getTime() - d.getTime() < 1728e5) return "昨天";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ── 主组件 ──

// ── 从邮箱地址提取公司名猜测 ──
function guessCompanyFromEmail(email: string): string {
  const m = email.match(/@(.+)$/);
  if (!m || !m[1]) return "";
  const domain = (m[1].split(".")[0] || "");
  return domain
    .replace(/[-_.]/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase())
    .slice(0, 50);
}

// ── 从姓名提取 firstName/lastName ──
function guessName(fromName: string | null): { firstName: string; lastName: string } {
  if (!fromName) return { firstName: "", lastName: "" };
  const parts = fromName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] || "", lastName: "" };
  return { firstName: parts[0] || "", lastName: parts[parts.length - 1] || "" };
}

export function InboxList() {
  const qc = useQueryClient();
  const [sid, setSid] = useState<number | null>(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [summary, setSummary] = useState<EmailSummary | null>(null);
  const [sl, setSl] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const [bl, setBl] = useState(false);
  // 前端正文缓存：点开过的邮件切回秒开，不重复 invoke / 不闪 loading
  const bodyCache = useRef<Map<number, string | null>>(new Map());

  // 联系人库（选中邮件后才加载）
  const { data: contactsData, isLoading: contactsLoading } = useQuery({
    queryKey: ["contacts", "match"],
    queryFn: () => window.api.invoke("contacts:listForMatch") as Promise<{ success: boolean; data?: { id: number; email: string; companyName: string | null }[] }>,
    enabled: sid !== null,
  });

  const [sel, setSel] = useState<Set<number>>(new Set());
  const [last, setLast] = useState<number | null>(null);
  const [viewed, setViewed] = useState<Set<string>>(loadViewed);
  const [menu, setMenu] = useState<{ x: number; y: number; item: InboxItem } | null>(null);
  // 虚拟滚动：只渲染可视区，避免千余封邮件全量渲染卡顿
  const ROW_H = 72; // 固定行高
  const SENDER_ROW_H = 54; // 发信人行高（固定）
  const OVERSCAN = 6; // 上下多渲染几行，滚动不露白
  const listRef = useRef<HTMLDivElement>(null);
  const [listH, setListH] = useState(600);
  const [scrollTop, setScrollTop] = useState(0);
  // 视图切换：全部邮件 / 按发信人
  const [view, setView] = useState<"flat" | "sender">("flat");
  const [senderFilter, setSenderFilter] = useState<string | null>(null); // 选中的发信人邮箱

  const { data, isLoading } = useQuery({
    queryKey: ["inbox"],
    queryFn: () => window.api.invoke("inbox:list") as Promise<{ success: boolean; data?: InboxItem[]; error?: string }>,
  });

  const [fetching, setFetching] = useState(false);
  // 多账号进度按 accountId 聚合，避免并行拉取时互相覆盖导致进度条跳变
  const [fetchProgress, setFetchProgress] = useState<Record<string, { scanned: number; total: number }>>({});
  const doFetch = async () => {
    setFetching(true);
    setFetchProgress({});
    try { await window.api.invoke("inbox:fetch"); } finally { setFetching(false); setFetchProgress({}); }
    qc.invalidateQueries({ queryKey: ["inbox"] });
  };

  const classMut = useMutation({
    mutationFn: (p: { id: number; classification: string }) => window.api.invoke("inbox:classify", p),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["inbox"] }),
  });
  const readMut = useMutation({
    mutationFn: (ids: number[]) => Promise.all(ids.map(id => window.api.invoke("inbox:markRead", id))),
  });
  const delMut = useMutation({
    mutationFn: (ids: number[]) => Promise.all(ids.map(id => window.api.invoke("inbox:delete", id))),
    onSuccess: () => { setSid(null); setSel(new Set()); qc.invalidateQueries({ queryKey: ["inbox"] }); },
  });
  const delBounceMut = useMutation({
    mutationFn: () => window.api.invoke("inbox:deleteBounce"),
    onSuccess: (r: unknown) => {
      const rr = r as { success: boolean; data?: number; error?: string };
      message[rr?.success ? "success" : "error"](rr?.success ? `已删除 ${rr.data} 封` : (rr?.error || "失败"));
      setSid(null); setSel(new Set()); qc.invalidateQueries({ queryKey: ["inbox"] });
    },
  });

  let items = data?.success ? data.data || [] : [];
  if (filter !== "all") items = items.filter(i => i.classification === filter);
  if (search.trim()) {
    const q = search.toLowerCase();
    items = items.filter(i => (i.subject || "").toLowerCase().includes(q) || i.fromEmail.toLowerCase().includes(q) || (i.fromName || "").toLowerCase().includes(q));
  }

  // 发信人聚合（按 fromEmail 精确分组，邮件数降序）
  const senderGroups = (() => {
    const map = new Map<string, { email: string; name: string | null; count: number; types: Set<string>; latest: string }>();
    for (const i of items) {
      const g = map.get(i.fromEmail);
      if (g) {
        g.count++;
        if (i.classification) g.types.add(i.classification);
        if (i.receivedAt > g.latest) g.latest = i.receivedAt;
      } else {
        map.set(i.fromEmail, { email: i.fromEmail, name: i.fromName, count: 1, types: new Set(i.classification ? [i.classification] : []), latest: i.receivedAt });
      }
    }
    return [...map.values()].sort((a, b) => (b.latest > a.latest ? 1 : b.latest < a.latest ? -1 : 0));
  })();

  // 发信人视图：选中某发信人则过滤
  if (view === "sender" && senderFilter) {
    items = items.filter(i => i.fromEmail === senderFilter);
  }
  const sel_ = items.find(i => i.id === sid) || null;

  // 虚拟滚动可视区计算
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const endIdx = Math.min(items.length, Math.ceil((scrollTop + listH) / ROW_H) + OVERSCAN);
  const visibleItems = items.slice(startIdx, endIdx);
  // 发信人可视区（独立行高）
  const senderStart = Math.max(0, Math.floor(scrollTop / SENDER_ROW_H) - OVERSCAN);
  const senderEnd = Math.min(senderGroups.length, Math.ceil((scrollTop + listH) / SENDER_ROW_H) + OVERSCAN);
  const visibleSenders = senderGroups.slice(senderStart, senderEnd);

  // 邮箱匹配 — 参照旧 PE _extractBodyContacts（memo 化，避免每次渲染重复正则处理大正文）
  const { matchedContacts, unmatchedEmails, senderContact, matchReady } = useMemo(() => {
    const matched: { email: string; company: string; id: number }[] = [];
    const unmatched: string[] = [];
    let sender: { company: string; id: number } | null = null;
    const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const ready = !!(body && contactsData?.success);
    if (ready) {
      const contacts = contactsData!.data || [];
      const idx: Record<string, { company: string; id: number }> = {};
      for (const c of contacts) {
        if (c.email) idx[c.email.toLowerCase().trim()] = { company: c.companyName || "", id: c.id };
      }
      // ① 发件人
      if (sel_) {
        const sk = sel_.fromEmail.toLowerCase().trim();
        const sc = idx[sk];
        if (sc) { sender = sc; matched.push({ email: sel_.fromEmail, company: sc.company, id: sc.id }); }
        else unmatched.push(sel_.fromEmail);
      }
      // ② 正文：剥 HTML 标签 + 拼接 raw 原文，跟旧 PE 一样
      const seen = new Set<string>();
      if (sel_) seen.add(sel_.fromEmail.toLowerCase().trim());
      const textBody = body!
        .replace(/<[^>]+>/g, " ")      // 剥 HTML → 纯文本
        .replace(/&[#a-z0-9]+;/gi, " ") // 实体解码
        .replace(/\s+/g, " ");          // 合并空白
      const emails = textBody.match(EMAIL_RE) || [];
      for (const em of emails) {
        if (matched.length >= 20) break;
        const key = em.toLowerCase().trim();
        if (seen.has(key)) continue;
        seen.add(key);
        const c = idx[key];
        if (c) matched.push({ email: em, company: c.company, id: c.id });
        else unmatched.push(em);
      }
    }
    return { matchedContacts: matched, unmatchedEmails: unmatched, senderContact: sender, matchReady: ready };
  }, [body, contactsData, sel_]);

  // 正文 iframe 文档（memo 化，避免每次渲染重新拼接大字符串触发 iframe 重载）
  const bodyDoc = useMemo(() => {
    if (!body) return undefined;
    return "<!DOCTYPE html><html><head><meta charset=utf-8><style>" +
      "html,body{margin:0;padding:0}" +
      "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.8;color:#333;padding:0 20px 20px}" +
      "a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}" +
      "blockquote{border-left:3px solid #d0d5dd;padding:4px 0 4px 12px;color:#667085;margin:12px 0}" +
      "table{border-collapse:collapse}" +
      "td,th{border:1px solid #e5e5e5;padding:6px 10px;font-size:13px}" +
      "pre{background:#f5f5f5;padding:10px 14px;border-radius:4px;font-size:12px;overflow-x:auto}" +
      "</style><script>var z=1;document.addEventListener('wheel',function(e){if(e.ctrlKey){e.preventDefault();z*=e.deltaY<0?1.1:0.9;z=Math.min(3,Math.max(0.3,z));document.body.style.zoom=z}},{passive:false})</script></head><body>" + body + "</body></html>";
  }, [body]);

  useEffect(() => { setSid(null); setSel(new Set()); setLast(null); }, [filter]);

  // 测量列表容器高度
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setListH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 过滤/搜索/视图/发信人变化时回到顶部
  useEffect(() => {
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [filter, search, view, senderFilter]);

  // 选中邮件 → 加载正文 + 量高度（优先前端缓存，切回已看邮件秒开）
  useEffect(() => {
    if (!sid) { setBody(null); return; }
    const cached = bodyCache.current.get(sid);
    if (cached !== undefined) {
      setBody(cached);
      return;
    }
    setBl(true);
    window.api.invoke("inbox:getBody", sid).then((r: unknown) => {
      const rr = r as { success: boolean; data?: string };
      const html = rr?.success ? rr.data || null : null;
      bodyCache.current.set(sid, html);
      setBody(html);
    }).catch(() => setBody(null)).finally(() => setBl(false));
  }, [sid, bodyCache]);


  // 首次加载：存量邮件全部标为已读
  const inited = useRef(false);
  useEffect(() => {
    const all = data?.success ? data.data || [] : [];
    if (!inited.current && all.length > 0) {
      const nv = new Set(loadViewed());
      all.forEach(i => nv.add(mk(i)));
      saveViewed(nv);
      setViewed(nv);
      inited.current = true;
    }
  }, [data]);

  useEffect(() => { const off = window.api.on("inbox:newMail", () => qc.invalidateQueries({ queryKey: ["inbox"] })); return off; }, [qc]);
  useEffect(() => {
    const off = window.api.on("inbox:fetchProgress", (p: unknown) => {
      const pp = p as { accountId: number; scanned: number; total: number };
      if (pp && typeof pp.scanned === "number") {
        setFetchProgress(prev => ({ ...prev, [String(pp.accountId ?? 0)]: { scanned: pp.scanned, total: pp.total || 0 } }));
      }
    });
    return off;
  }, []);

  // 从联系人/CRM跳转来 → 自动搜索邮箱
  useEffect(() => {
    const rawHash = window.location.hash;
    const qs = rawHash.includes("?") ? rawHash.split("?")[1] : "";
    if (!qs) return;
    const sp = new URLSearchParams(qs);
    const q = sp.get("search");
    if (q) {
      setSearch(q);
      const base = rawHash.split("?")[0]!;
      window.location.hash = base;
    }
  }, []);

  const click = useCallback((e: React.MouseEvent, item: InboxItem) => {
    const id = item.id;
    let ns = new Set(sel);
    if (e.shiftKey && last !== null) {
      const vi = items.map(i => i.id), ap = vi.indexOf(last), cp = vi.indexOf(id);
      if (ap >= 0 && cp >= 0) { const [f, t] = ap < cp ? [ap, cp] : [cp, ap]; ns = new Set(vi.slice(f, t + 1)); }
    } else if (e.ctrlKey || e.metaKey) { ns.has(id) ? ns.delete(id) : ns.add(id); }
    else { ns = ns.has(id) && ns.size === 1 ? new Set() : new Set([id]); }
    setSel(ns); setLast(id); setSid(id);
    const nv = new Set(viewed); nv.add(mk(item)); setViewed(nv); saveViewed(nv);
    readMut.mutate([id]);
  }, [items, sel, last, viewed]);

  const ctxMenu = useCallback((e: React.MouseEvent, item: InboxItem) => {
    e.preventDefault();
    if (!sel.has(item.id)) { setSel(new Set([item.id])); setSid(item.id); }
    setMenu({ x: e.clientX, y: e.clientY, item });
  }, [sel]);

  useEffect(() => { if (!menu) return; const c = () => setMenu(null); document.addEventListener("click", c); return () => document.removeEventListener("click", c); }, [menu]);

  const batchRead = () => {
    const ids = [...sel], nv = new Set(viewed);
    items.filter(i => sel.has(i.id)).forEach(i => nv.add(mk(i)));
    setViewed(nv); saveViewed(nv); readMut.mutate(ids); message.success("已标为已读");
  };
  const batchDel = () => {
    if (!sel.size) return;
    Modal.confirm({ title: `删除 ${sel.size} 封？`, okText: "删除", okType: "danger", cancelText: "取消", onOk: () => delMut.mutate([...sel]) });
  };
  const batchType = async (t: string) => {
    for (const id of sel) await classMut.mutateAsync({ id, classification: t });
    message.success(`已标为 ${TYPE[t]?.label || t}`);
  };

  // 统计基于全量数据，未读只看有分类的
  const allItems = data?.success ? data.data || [] : [];
  const counts: Record<string, number> = { bounce: 0, replied: 0, autoreply: 0, sent: 0, other: 0 };
  allItems.forEach(i => { const t = i.classification || "other"; if (counts[t] !== undefined) counts[t]++; });
  const nCounts: Record<string, number> = { bounce: 0, replied: 0, autoreply: 0, other: 0 };
  allItems.forEach(i => { if (!viewed.has(mk(i))) { const t = i.classification || "other"; if (nCounts[t] !== undefined) nCounts[t]++; } });

  // ── 渲染 ──

  return (
    <div className="flex h-full" style={{ minHeight: "calc(100vh - 130px)" }} onClick={() => setMenu(null)}>

      {/* ══ 左侧 ══ */}
      <div className="flex flex-col flex-shrink-0 bg-white" style={{ width: "40%", minWidth: 340, userSelect: "none", borderRight: "1px solid #e8e8e8" }}>

        {/* 顶部 */}
        <div style={{ padding: "12px 14px 8px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <button onClick={doFetch} disabled={fetching} className="btn"
            style={{ padding: "5px 12px", fontSize: 11, gap: 4 }}>
            <ReloadOutlined className={fetching ? "animate-spin" : ""} style={{ fontSize: 12 }} /> 刷新
          </button>
          <input
            placeholder="搜索..." value={search} onChange={e => setSearch(e.target.value)}
            style={{ flex: 1, border: "1px solid #e5e5e5", borderRadius: 6, padding: "5px 10px", fontSize: 11, outline: "none", minWidth: 0 }} />
          {sel.size > 1 && <button onClick={batchRead} className="btn" style={{ padding: "5px 8px", fontSize: 10 }}>已读</button>}
          {sel.size > 1 && <button onClick={batchDel} className="btn" style={{ padding: "5px 8px", fontSize: 10, color: "#e5484d", borderColor: "#fecaca" }}>删({sel.size})</button>}
        </div>
        {/* 拉取读条 — 多账号聚合进度，避免跳变 */}
        {Object.keys(fetchProgress).length > 0 && (() => {
          const scanned = Object.values(fetchProgress).reduce((s, x) => s + x.scanned, 0);
          const total = Object.values(fetchProgress).reduce((s, x) => s + x.total, 0);
          return (
            <div style={{ padding: "0 14px 6px", flexShrink: 0 }}>
              <Progress
                percent={total > 0 ? Math.round((scanned / total) * 100) : 0}
                size="small" status="active" strokeColor="#2563eb"
                format={() => `${scanned}/${total}`}
              />
            </div>
          );
        })()}

        {/* 计数条 */}
        <div style={{ padding: "2px 14px 6px", fontSize: 10, color: "#bbb", display: "flex", gap: 8, flexShrink: 0 }}>
          <span>退信 {counts.bounce ?? 0}</span>
          <span>回复 {counts.replied ?? 0}</span>
          <span>已发送 {counts.sent ?? 0}</span>
          <span>自动回复 {counts.autoreply ?? 0}</span>
          <span>其他 {counts.other ?? 0}</span>
        </div>

        {/* 视图切换 */}
        <div style={{ display: "flex", padding: "4px 14px", gap: 4, flexShrink: 0 }}>
          {(["flat", "sender"] as const).map(v => {
            const on = view === v;
            return (
              <button key={v} onClick={() => { setView(v); setSenderFilter(null); }}
                style={{
                  flex: 1, padding: "5px 0", fontSize: 11, cursor: "pointer", border: "1px solid #e5e5e5",
                  borderRadius: 6, background: on ? "#1a1a1a" : "#fff", color: on ? "#fff" : "#666",
                  fontWeight: on ? 600 : 400, transition: "all .12s",
                }}>
                {v === "flat" ? "全部邮件" : "按发信人"}
              </button>
            );
          })}
        </div>

        {/* 发信人选中后的面包屑栏：让用户一眼看出是从发信人列表点进来的邮件汇总 */}
        {view === "sender" && senderFilter && (() => {
          const cur = senderGroups.find(g => g.email === senderFilter);
          const curName = cur?.name || senderFilter;
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "1px solid #e8e8e8", background: "#fafafa", flexShrink: 0 }}>
              <button onClick={() => setSenderFilter(null)}
                style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 10px", fontSize: 11, cursor: "pointer", border: "1px solid #e5e5e5", borderRadius: 6, background: "#fff", color: "#555", flexShrink: 0, transition: "all .12s" }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "#2563eb"; (e.currentTarget as HTMLElement).style.color = "#2563eb"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#e5e5e5"; (e.currentTarget as HTMLElement).style.color = "#555"; }}>
                ← 返回发信人列表
              </button>
              <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#1a1a1a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{curName}</span>
                {curName !== senderFilter && (
                  <span style={{ fontSize: 10, color: "#999", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{senderFilter}</span>
                )}
              </div>
            </div>
          );
        })()}

        {/* 筛选 */}
        <div style={{ display: "flex", borderBottom: "1px solid #e8e8e8", flexShrink: 0 }}>
          {FILTERS.map(f => {
            const on = filter === f.key;
            return (
              <button key={f.key} onClick={() => setFilter(f.key)}
                style={{
                  flex: 1, padding: "8px 0", fontSize: 11, cursor: "pointer", border: 0, background: "none",
                  color: on ? "#1a1a1a" : "#999", fontWeight: on ? 600 : 400,
                  boxShadow: on ? "inset 0 -2px 0 #1a1a1a" : "none",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 3, whiteSpace: "nowrap",
                  transition: "color .12s",
                }}
                onMouseEnter={e => { if (!on) (e.currentTarget as HTMLElement).style.color = "#666"; }}
                onMouseLeave={e => { if (!on) (e.currentTarget as HTMLElement).style.color = "#999"; }}
              >
                {"dot" in f && <span style={{ fontSize: 8, color: f.dot, lineHeight: 1, flexShrink: 0 }}>●</span>}
                {f.label}
                {f.key !== "all" && (nCounts[f.key] ?? 0) > 0 && <span style={{ fontSize: 8, color: "#e5484d", lineHeight: 1, flexShrink: 0 }}>●</span>}
              </button>
            );
          })}
        </div>

        {/* 退信删除 */}
        {filter === "bounce" && items.length > 0 && (
          <button onClick={() => { Modal.confirm({ title: `确认删除 ${items.filter(i => i.classification === "bounce").length} 封退信？`, okText: "删除", okType: "danger", cancelText: "取消", onOk: () => delBounceMut.mutate() }); }}
            style={{ width: "100%", padding: "7px 0", border: 0, fontSize: 11, fontWeight: 500, cursor: "pointer", color: "#fff", background: "#e5484d", flexShrink: 0 }}>删除全部退信</button>
        )}

        {/* 列表 */}
        <div ref={listRef} className="thin-scroll" style={{ flex: 1, overflow: "auto" }}
          onScroll={e => {
            const top = e.currentTarget.scrollTop;
            const rowH = (view === "sender" && !senderFilter) ? SENDER_ROW_H : ROW_H;
            setScrollTop(prev => (Math.abs(prev - top) >= rowH ? top : prev));
          }}>
          {view === "sender" && !senderFilter ? (
            senderGroups.length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 0", fontSize: 13, color: "#ccc" }}>暂无邮件</div>
            ) : (
              <div style={{ height: senderGroups.length * SENDER_ROW_H, position: "relative" }}>
                {visibleSenders.map((g, idx) => {
                  const realIdx = senderStart + idx;
                  return (
                    <div key={g.email} onClick={() => setSenderFilter(g.email)}
                      style={{ position: "absolute", top: realIdx * SENDER_ROW_H, left: 0, right: 0, height: SENDER_ROW_H, boxSizing: "border-box", display: "flex", alignItems: "center", gap: 8, padding: "6px 14px", cursor: "pointer", borderBottom: "1px solid #f5f5f5" }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(0,0,0,.015)"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "#1a1a1a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {g.name || g.email}
                        </div>
                        <div style={{ fontSize: 10, color: "#999", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {g.email} · {shortTime(g.latest)}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                        {(["replied", "bounce", "autoreply", "other", "sent"] as const).filter(t => g.types.has(t)).map(t => (
                          <span key={t} style={{ width: 6, height: 6, borderRadius: "50%", background: TYPE[t]?.dot || "#8b8b8b" }} />
                        ))}
                      </div>
                      <span style={{ fontSize: 10, color: "#bbb", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{g.count} 封</span>
                    </div>
                  );
                })}
              </div>
            )
          ) : isLoading ? <div style={{ textAlign: "center", padding: "40px 0", fontSize: 13, color: "#ccc" }}>加载中...</div>
            : items.length === 0 ? <div style={{ textAlign: "center", padding: "40px 0", fontSize: 13, color: "#ccc" }}>{search ? "无匹配" : "暂无邮件"}</div>
              : (
                <div style={{ height: items.length * ROW_H, position: "relative" }}>
                  {visibleItems.map((i, idx) => {
                    const realIdx = startIdx + idx;
                    const t = TYPE[i.classification || "other"]!;
                const isNew = !viewed.has(mk(i));
                const isSel = sel.has(i.id);
                const isAct = i.id === sid;
                return (
                  <div key={i.id}
                    onClick={e => click(e, i)}
                    onContextMenu={e => ctxMenu(e, i)}
                    style={{
                      position: "absolute", top: realIdx * ROW_H, left: 0, right: 0, height: ROW_H,
                      boxSizing: "border-box",
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "10px 14px 10px 11px", cursor: "pointer",
                      background: isAct ? "rgba(0,0,0,.04)" : "transparent",
                      borderLeft: isAct ? "3px solid #1a1a1a" : "3px solid transparent",
                      borderBottom: "1px solid #f5f5f5",
                      transition: "background .12s",
                    }}
                    onMouseEnter={e => { if (!isAct) (e.currentTarget as HTMLElement).style.background = "rgba(0,0,0,.015)"; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isAct ? "rgba(0,0,0,.04)" : "transparent"; }}
                  >
                    <span style={{ flexShrink: 0, width: 10, textAlign: "center" }}>
                      <span style={{ color: t.dot, fontSize: 8, lineHeight: 1, display: "inline-block", transform: isNew ? "scale(1.8)" : "scale(1)", transition: "transform .3s ease" }}>●</span>
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 1 }}>
                        <span style={{ fontSize: 13, fontWeight: isNew ? 500 : 400, color: "#1a1a1a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {i.subject || i.fromName || i.fromEmail}
                        </span>
                        <span style={{ fontSize: 10, color: "#bbb", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{shortTime(i.receivedAt)}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 1 }}>
                        <span style={{ fontSize: 11, color: "#999", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>{i.fromName || i.fromEmail}</span>
                        {i.classification && i.classification !== "other" && <span style={{ fontSize: 9, padding: "0 6px", borderRadius: 10, background: t.dot + "15", color: t.dot, flexShrink: 0 }}>{t.label}</span>}
                      </div>
                      {/* 已匹配 + 联系人状态（始终显示） */}
                      {(() => {
                        const tags = (() => { try { const t = JSON.parse(i._contactTags || "[]"); return Array.isArray(t) ? t : []; } catch { return []; } })();
                        const hasAny = i.matchedContactId || i._contactStatus || tags.length > 0;
                        if (!hasAny) return null;
                        return (
                          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, color: "#bbb", marginTop: 1 }}>
                            {i.matchedContactId && <span>已匹配</span>}
                            {i._contactStatus && (
                              <>
                                <span style={{
                                  width: 5, height: 5, borderRadius: "50%", display: "inline-block",
                                  background: i._contactStatus === "replied" ? "#22a644" : i._contactStatus === "bounced" ? "#e5484d" : i._contactStatus === "autoreply" ? "#e6a817" : i._contactStatus === "reached" ? "#2563eb" : "#ccc",
                                }} />
                                <span>{i._contactStatus}</span>
                              </>
                            )}
                            {tags.length > 0 && <span>{tags.join(", ")}</span>}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
                  })}
                </div>
              )}
        </div>
      </div>

      {/* ══ 右侧 ══ */}
      <div className="flex-1 bg-white flex flex-col overflow-hidden">
        {!sel_ ? (
          <div className="flex-1 flex flex-col items-center justify-center" style={{ color: "#ddd" }}>
            <MailOutlined style={{ fontSize: 32, marginBottom: 10 }} />
            <span style={{ fontSize: 13 }}>选择左侧邮件</span>
          </div>
        ) : (
          <>
            {/* 头部 — 紧凑双列网格（label 宽度压缩，账号+关联一行，状态+标签一行） */}
            <div className="selectable" style={{ borderBottom: "1px solid #e8e8e8", flexShrink: 0 }}>
              {[
                ["发件人", `${sel_.fromName || ""} <${sel_.fromEmail}>`, true],
                ["主题", sel_.subject || "无主题", true],
                ["时间", new Date(sel_.receivedAt).toLocaleString("zh-CN"), false],
                ["分类", sel_.classification || "other", false],
              ].map(([label, value, full], idx) => (
                <div key={idx}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, padding: "5px 12px", borderBottom: "1px solid #f5f5f5", width: full ? "100%" : "50%" }}>
                  <span style={{ color: "#999", fontWeight: 600, fontSize: 10, minWidth: 36, flexShrink: 0 }}>{label}</span>
                  <span style={{ wordBreak: "break-all", lineHeight: 1.4, minWidth: 0 }}>
                    {label === "分类" ? (
                      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: (TYPE as Record<string, {dot: string}>)[String(value)]?.dot || "#8b8b8b" }} />
                        {(TYPE as Record<string, {label: string}>)[String(value)]?.label || String(value)}
                      </span>
                    ) : String(value)}
                  </span>
                </div>
              ))}
              {/* 账号 + 关联 一行两栏 */}
              <div style={{ display: "flex", borderBottom: "1px solid #f5f5f5" }}>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, padding: "5px 12px", width: senderContact ? "50%" : "100%" }}>
                  <span style={{ color: "#999", fontWeight: 600, fontSize: 10, minWidth: 36, flexShrink: 0 }}>账号</span>
                  <span style={{ fontSize: 11, color: (sel_ as InboxItem & { _accountEmail?: string })._accountEmail ? "#555" : "#ccc", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {(sel_ as InboxItem & { _accountEmail?: string })._accountEmail || "—"}
                  </span>
                </div>
                {senderContact && (
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, padding: "5px 12px", width: "50%" }}>
                    <span style={{ color: "#999", fontWeight: 600, fontSize: 10, minWidth: 36, flexShrink: 0 }}>关联</span>
                    <span
                      onClick={() => { window.location.hash = `#/contacts?detail=${senderContact.id}`; }}
                      style={{ color: "#1565c0", fontWeight: 500, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: "2px", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title="点击打开联系人详情"
                    >{senderContact.company || "已匹配联系人"}</span>
                  </div>
                )}
              </div>
              {/* 状态 + 标签 一行两栏 */}
              {sel_ && (() => {
                const status = (sel_ as InboxItem & { _contactStatus?: string })._contactStatus || null;
                const rawTags = (sel_ as InboxItem & { _contactTags?: string })._contactTags || "[]";
                const tags: string[] = (() => { try { const t = JSON.parse(rawTags); return Array.isArray(t) ? t : []; } catch { return []; } })();
                const statusDot: Record<string, string> = { replied: "#22a644", bounce: "#e5484d", autoreply: "#e6a817", reached: "#2563eb" };
                const statusLabel: Record<string, string> = { replied: "已回复", bounce: "退信", autoreply: "自动回复", reached: "已触达" };
                return (
                  <div style={{ display: "flex", borderBottom: "1px solid #f5f5f5" }}>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, padding: "5px 12px", width: "50%" }}>
                      <span style={{ color: "#999", fontWeight: 600, fontSize: 10, minWidth: 36, flexShrink: 0 }}>状态</span>
                      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        {status && <span style={{ width: 6, height: 6, borderRadius: "50%", background: statusDot[status] || "#ccc" }} />}
                        <span style={{ fontSize: 11, color: status ? "#555" : "#ccc" }}>{status ? (statusLabel[status] || status) : "—"}</span>
                      </span>
                    </div>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, padding: "5px 12px", width: "50%" }}>
                      <span style={{ color: "#999", fontWeight: 600, fontSize: 10, minWidth: 36, flexShrink: 0 }}>标签</span>
                      <span style={{ fontSize: 11, color: tags.length > 0 ? "#555" : "#ccc", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tags.length > 0 ? tags.join(", ") : "—"}</span>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* 联系人匹配栏 — 始终显示 */}
            {sid && (
              <div style={{ borderBottom: "1px solid #e8e8e8", flexShrink: 0, padding: "6px 18px", fontSize: 11 }}>
                {!matchReady ? (
                  <span style={{ fontSize: 10, color: "#ccc" }}>{contactsLoading || bl ? "加载中..." : "未提取"}</span>
                ) : (
                  <>
                    {matchedContacts.length > 0 && (
                      <div style={{ marginBottom: unmatchedEmails.length > 0 ? 4 : 0 }}>
                        <span style={{ fontSize: 10, color: "#999", textTransform: "uppercase", letterSpacing: ".5px" }}>已匹配 {matchedContacts.length} 人</span>
                        {matchedContacts.map((c, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 0", fontSize: 11 }}>
                            <span
                              onClick={() => { window.location.hash = `#/contacts?detail=${c.id}`; }}
                              style={{ color: "#1565c0", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: "2px" }}
                              title="点击打开联系人详情"
                            >{c.email}</span>
                            <span style={{ color: "#ccc" }}>→</span>
                            <b>{c.company || "未知公司"}</b>
                          </div>
                        ))}
                      </div>
                    )}
                    {unmatchedEmails.length > 0 && (
                      <div>
                        <span style={{ fontSize: 10, color: "#999", textTransform: "uppercase", letterSpacing: ".5px" }}>未匹配 {unmatchedEmails.length} 个邮箱 — 点击添加</span>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 6px", marginTop: 2 }}>
                          {unmatchedEmails.slice(0, 10).map((e, i) => {
                            const company = guessCompanyFromEmail(e);
                            const name = sel_ ? guessName(sel_.fromName) : { firstName: "", lastName: "" };
                            return (
                              <Tooltip key={i} title={company ? `推测公司: ${company}` : "添加为联系人"}>
                                <span
                                  onClick={() => {
                                    const params = new URLSearchParams();
                                    params.set("add", "1");
                                    params.set("email", e);
                                    if (company) params.set("company", company);
                                    if (name.firstName) params.set("firstName", name.firstName);
                                    if (name.lastName) params.set("lastName", name.lastName);
                                    window.location.hash = `#/contacts?${params.toString()}`;
                                  }}
                                  style={{
                                    fontSize: 10, background: "#e8f4fd", padding: "1px 8px",
                                    borderRadius: 3, color: "#1565c0", cursor: "pointer",
                                    border: "1px solid #bbdefb", transition: "all .12s",
                                  }}
                                  onMouseEnter={t => {
                                    t.currentTarget.style.background = "#bbdefb";
                                    t.currentTarget.style.borderColor = "#90caf9";
                                  }}
                                  onMouseLeave={t => {
                                    t.currentTarget.style.background = "#e8f4fd";
                                    t.currentTarget.style.borderColor = "#bbdefb";
                                  }}
                                >+ {e}</span>
                              </Tooltip>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {matchedContacts.length === 0 && unmatchedEmails.length === 0 && (
                      <span style={{ fontSize: 10, color: "#ccc" }}>未提取</span>
                    )}
                  </>
                )}
              </div>
            )}

            {/* 正文 */}
            <div className="detail-body">
              <div className="body-pane" style={{ height: "calc(100vh - 290px)", display: "flex", flexDirection: "column" }}>
                <div style={{ padding: "14px 20px 0", flexShrink: 0 }}>
                  <EmailAiSummary data={sel_} summary={summary} setSummary={setSummary} sl={sl} setSl={setSl} qc={qc} />
                </div>
                {bl ? (
                  <div style={{ textAlign: "center", padding: "60px 0", color: "#ccc", fontSize: 13 }}>加载正文中...</div>
                ) : body ? (
                  <iframe className="body-iframe" style={{ flex: 1, minHeight: 0, width: "100%" }}
                    scrolling="auto" sandbox="allow-scripts"
                    srcDoc={bodyDoc}
                  />
                ) : (
                  <div className="body-preview selectable">{sel_.bodyPreview || "(无法加载正文)"}</div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* 右键菜单 */}
      {menu && (
        <div style={{ position: "fixed", zIndex: 50, left: menu.x, top: menu.y, minWidth: 140, background: "#fff", borderRadius: 8, padding: "4px 0", border: "1px solid #e5e5e5", boxShadow: "0 4px 16px rgba(0,0,0,.08)", fontSize: 12 }}>
          <div className="ctx-item" onClick={() => { batchRead(); setMenu(null); }}>一键已读</div>
          <div className="ctx-item" onClick={() => {
            const rs = menu.item.subject?.match(/^Re:\s*/i) ? menu.item.subject : `Re: ${menu.item.subject || ""}`;
            window.open(`mailto:${menu.item.fromEmail}?subject=${encodeURIComponent(rs)}`, "_blank");
            setMenu(null);
          }}>回复</div>
          <div style={{ borderTop: "1px solid #eee", margin: "2px 0" }} />
          {(["replied", "bounce", "autoreply", "sent", "other"] as const).filter(t => t !== (menu.item.classification || "other")).map(t => (
            <div key={t} className="ctx-item" onClick={() => { batchType(t); setMenu(null); }} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: TYPE[t]!.dot }} />设为 {TYPE[t]!.label}
            </div>
          ))}
          <div style={{ borderTop: "1px solid #eee", margin: "2px 0" }} />
          <div className="ctx-item" style={{ color: "#e5484d" }} onClick={() => { delMut.mutate([...sel]); setMenu(null); }}>
            {sel.size > 1 ? `删除选中 (${sel.size})` : "删除"}
          </div>
        </div>
      )}

      {/* 右键菜单 hover 样式 */}
      <style>{`
        .ctx-item{padding:6px 12px;cursor:pointer;transition:background .1s}.ctx-item:hover{background:#f5f5f5}
        .btn{border:1px solid #e5e5e5;border-radius:6px;background:#fff;cursor:pointer;transition:all .12s;display:flex;align-items:center}
        .btn:hover{background:#f5f5f5;border-color:#d5d5d5}
        .btn:active{background:#eee}
        .detail-body .ant-tabs-tabpane{overflow:visible!important}
        .body-pane{overflow:hidden!important}
        .body-iframe{width:100%!important;border:0!important;display:block!important}
        .body-preview{flex:1!important;padding:20px!important;font-size:14px!important;color:#555!important;white-space:pre-wrap!important;line-height:1.9!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;overflow-y:auto!important}
        .thin-scroll::-webkit-scrollbar{width:6px}
        .thin-scroll::-webkit-scrollbar-track{background:transparent}
        .thin-scroll::-webkit-scrollbar-thumb{background:#d5d5d5;border-radius:3px}
        .thin-scroll::-webkit-scrollbar-thumb:hover{background:#bbb}
      `}</style>
    </div>
  );
}

// ── AI 总结 ──

function EmailAiSummary(props: {
  data: InboxItem; summary: EmailSummary | null; setSummary: (s: EmailSummary | null) => void;
  sl: boolean; setSl: (b: boolean) => void; qc: ReturnType<typeof useQueryClient>;
}) {
  const { data: d, summary, setSummary, sl, setSl, qc } = props;
  const run = async () => {
    setSl(true);
    try {
      const r = await window.api.invoke("ai:summarizeEmail", { fromName: d.fromName, fromEmail: d.fromEmail, subject: d.subject, bodyPreview: d.bodyPreview }) as { success: boolean; data?: EmailSummary; error?: string };
      if (r?.success && r.data) setSummary(r.data); else message.error(r?.error || "失败");
    } catch { message.error("失败"); } finally { setSl(false); }
  };
  const save = async () => {
    if (!d.matchedContactId) { message.warning("未匹配联系人"); return; }
    const r = await window.api.invoke("crm:addNote", { contactId: d.matchedContactId, text: `【AI 总结】${summary?.summary || ""}\n【建议】${summary?.nextStep || ""}` }) as { success: boolean; error?: string };
    if (r?.success) { message.success("已写入跟进"); qc.invalidateQueries({ queryKey: ["contacts", "interactions"] }); qc.invalidateQueries({ queryKey: ["crm"] }); } else message.error(r?.error || "失败");
  };
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <Button size="small" icon={<ThunderboltOutlined />} loading={sl} onClick={run}>AI 总结</Button>
        {summary && <Button size="small" icon={<SaveOutlined />} onClick={save} disabled={!d.matchedContactId}>写入跟进</Button>}
      </div>
      {summary && <Alert type="success" showIcon className="mb-2" message={<div className="text-xs space-y-1.5"><div><b className="text-gray-700">总结：</b><span className="text-gray-600">{summary.summary}</span></div><div><b className="text-gray-700">建议：</b><span className="text-gray-600">{summary.nextStep}</span></div></div>} />}
    </div>
  );
}
