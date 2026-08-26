import { ipcMain, BrowserWindow } from "electron";
import * as tls from "tls";
import * as net from "net";
import { IPC } from "../contract";
import * as InboxService from "../services/inbox.service";
import { Log } from "../logger";
import { failResult, okResult, type Result } from "../errors";
import { getDb } from "../db";
import { inboxMessages } from "../db/schema/inbox";
import { emailAccounts } from "../db/schema/accounts";
import { interactions } from "../db/schema/interactions";
import { eq, and, sql } from "drizzle-orm";
import { saveDatabase } from "../db";
import { getDecryptedPassword } from "../services/account.service";
import * as path from "path";
import * as fs from "fs";
import * as imapflow from "imapflow";
import { simpleParser } from "mailparser";

// ── 拉取时间窗口（天）──
// ponytail: 只拉最近 N 天，替代 uid 增量（uid 增量在大量历史邮件下会卡死停在一个日期）
const FETCH_DAYS = 5;

// ── POP3 端口检测 ──

function isPop3Port(port: number): boolean {
  return port === 110 || port === 995;
}

// ── mailparser 统一解析 ──

async function parseRawEmail(rawSource: string | Buffer): Promise<{
  subject: string; fromEmail: string; fromName: string | null;
  to: string[]; cc: string[];
  bodyText: string; bodyHtml: string; date: string;
} | null> {
  try {
    // Buffer（IMAP）直接解析保字节；string（POP3 latin1 保字节）转回 Buffer 再解析，避免双重转码破坏 MIME/中文/签名
    const input = typeof rawSource === "string" ? Buffer.from(rawSource, "latin1") : rawSource;
    const parsed = await simpleParser(input);
    const fromAddr = parsed.from?.value?.[0]?.address || "";
    const fromName = parsed.from?.value?.[0]?.name || null;
    // mailparser: to/cc 可能是单个 AddressObject 或数组，统一归一化成地址列表
    const normAddr = (v: unknown): string[] => {
      if (!v) return [];
      const list = Array.isArray(v) ? v : [v];
      return list.flatMap((x) => ((x as { value?: Array<{ address?: string }> })?.value || []).map(a => a.address || "")).filter(Boolean);
    };
    const to = normAddr(parsed.to);
    const cc = normAddr(parsed.cc);
    const subject = parsed.subject || "(无主题)";
    const bodyText = parsed.text || "";
    const bodyHtml = parsed.html || parsed.text || "";

    const d = parsed.date || new Date();
    const dp = d.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    const tp = d.toLocaleTimeString("en-CA", { timeZone: "Asia/Shanghai", hour12: false });
    const date = `${dp}T${tp}+08:00`;

    return { subject, fromEmail: fromAddr, fromName, to, cc, bodyText, bodyHtml, date };
  } catch {
    return null;
  }
}

// ── POP3 底层（参考旧 PE，latin1 保字节完整性）──

type Pop3Socket = tls.TLSSocket | net.Socket;

function pop3Connect(host: string, port: number): Promise<Pop3Socket> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: false }, () => resolve(sock));
    sock.on("error", reject);
    setTimeout(() => { sock.destroy(); reject(new Error("连接超时")); }, 15000);
  });
}

function pop3ReadLine(sock: Pop3Socket, timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => { sock.removeAllListeners("data"); reject(new Error("读行超时")); }, timeoutMs);
    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      const rn = buf.indexOf("\r\n");
      const n = buf.indexOf("\n");
      const end = rn >= 0 ? rn : n;
      if (end >= 0) {
        clearTimeout(timer);
        sock.removeListener("data", onData);
        resolve(buf.slice(0, end).trim());
      }
    };
    sock.on("data", onData);
  });
}

/** 读取多行响应（UIDL/LIST），检测 \r\n.\r\n 终止 */
function pop3ReadMulti(sock: Pop3Socket, timeoutMs = 45000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      sock.removeAllListeners("data");
      reject(new Error("读多行超时"));
    }, timeoutMs);
    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      // -ERR 单行错误立即返回
      if (buf.length < 200 && /^\s*-ERR/i.test(buf) && buf.includes("\n")) {
        clearTimeout(timer);
        sock.removeListener("data", onData);
        return resolve([buf.replace(/[\r\n].*/, "").trim()]);
      }
      if (/\r?\n\.\r?\n/.test(buf)) {
        clearTimeout(timer);
        sock.removeListener("data", onData);
        const lines = buf.replace(/\r?\n\.\r?\n.*/, "").split(/\r?\n/);
        // 首行是 +OK，去掉
        resolve(lines.length > 1 && /^[+-]/.test(lines[0]!) ? lines.slice(1) : lines);
      }
    };
    sock.on("data", onData);
  });
}

/** 读取 RETR 原始响应，返回完整 raw source */
function pop3ReadRaw(sock: Pop3Socket, timeoutMs = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      sock.removeAllListeners("data");
      reject(new Error("RETR 读超时"));
    }, timeoutMs);
    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      if (/\r?\n\.\r?\n/.test(buf)) {
        clearTimeout(timer);
        sock.removeListener("data", onData);
        // 去掉终止标记 \r\n.\r\n，拆出行，去首行 +OK 和末行 .
        const lines = buf.replace(/\r?\n\.\r?\n.*/, "").split(/\r?\n/);
        // dot-stuffing: 行首 .. → .
        const unstuffed = lines.slice(1).map(l => l.startsWith("..") ? l.slice(1) : l);
        resolve(unstuffed.join("\r\n"));
      }
    };
    sock.on("data", onData);
  });
}

function pop3Cmd(sock: Pop3Socket, cmd: string): Promise<string[]> {
  sock.write(cmd + "\r\n");
  if (cmd === "QUIT") return Promise.resolve([]);
  if (cmd.startsWith("RETR")) return pop3ReadRaw(sock).then(raw => [raw]);
  if (cmd.startsWith("LIST") || cmd.startsWith("UIDL")) return pop3ReadMulti(sock);
  return pop3ReadLine(sock).then(line => [line]);
}

// ── POP3 抓取 ──

async function doPop3Fetch(accountId: number): Promise<Result<InboxService.InboxMessageRow[]>> {
  const account = getDb().select().from(emailAccounts).where(eq(emailAccounts.id, accountId)).get();
  if (!account) return failResult("账号未找到");
  if (!account.imapHost) return failResult("未配置 POP3/IMAP 服务器");

  const passRes = getDecryptedPassword(account.id);
  if (!passRes.success) return failResult("账号密码解密失败: " + passRes.error);

  const host = account.imapHost;
  const port = account.imapPort || 995;

  Log.debug("inbox.pop3", `连接 POP3 ${host}:${port}`);

  let sock: Pop3Socket | undefined;
  try {
    sock = await pop3Connect(host, port);
    await pop3ReadLine(sock, 15000); // greeting

    const userRes = await pop3Cmd(sock, `USER ${account.email}`);
    if (!userRes[0]?.startsWith("+OK")) { sock.destroy(); return failResult(`POP3 USER 失败: ${userRes[0]}`); }

    const passRes2 = await pop3Cmd(sock, `PASS ${passRes.data}`);
    if (!passRes2[0]?.startsWith("+OK")) { sock.destroy(); return failResult(`POP3 认证失败: ${passRes2[0]}`); }

    const statRes = await pop3Cmd(sock, "STAT");
    const statMatch = statRes[0]?.match(/^\+OK\s+(\d+)/);
    const total = statMatch ? parseInt(statMatch[1]!, 10) : 0;
    Log.info("inbox.pop3", `${account.email}: ${total} 封邮件`);

    if (total === 0) { sock.write("QUIT\r\n"); sock.destroy(); return okResult([]); }

    // UIDL
    let uidMap = new Map<number, string>();
    try {
      const uidlRes = await pop3Cmd(sock, "UIDL");
      if (uidlRes[0]?.startsWith("-ERR")) {
        // 降级 LIST
        const listRes = await pop3Cmd(sock, "LIST");
        for (const line of listRes) {
          const m = line.match(/^(\d+)\s+/);
          if (m) uidMap.set(parseInt(m[1]!, 10), String(m[1]));
        }
      } else {
        for (const line of uidlRes) {
          const m = line.match(/^(\d+)\s+(.+)/);
          if (m) uidMap.set(parseInt(m[1]!, 10), m[2]!);
        }
      }
    } catch {
      // UIDL 超时，降级 LIST
      const listRes = await pop3Cmd(sock, "LIST");
      for (const line of listRes) {
        const m = line.match(/^(\d+)\s+/);
        if (m) uidMap.set(parseInt(m[1]!, 10), String(m[1]));
      }
    }

    // 获取最近 40 封
    const fetchCount = Math.min(total, 40);
    const startIdx = Math.max(1, total - fetchCount + 1);
    const parsed: InboxService.InboxMessageRow[] = [];
    const bounceSeen = new Set<string>();

    for (let i = startIdx; i <= total; i++) {
      const uid = uidMap.get(i) || `pop3-${accountId}-${i}`;

      // 去重 + 已删除集过滤
      if (InboxService.isDeleted(`${accountId}|${uid}`)) continue;
      const exist = getDb().select().from(inboxMessages)
        .where(eq(inboxMessages.messageId, uid)).get();
      if (exist) continue;

      const retrRes = await pop3Cmd(sock, `RETR ${i}`);
      const raw = retrRes[0] || "";

      const msg = await parseRawEmail(raw);
      if (!msg) continue;

      // 我方角色：直接收件（to）还是仅被抄送（cc）
      const myEmail = account.email.toLowerCase();
      const myRole = msg.to.some(a => a.toLowerCase() === myEmail) ? "to"
        : msg.cc.some(a => a.toLowerCase() === myEmail) ? "cc" : null;

      const contact = InboxService.matchContact(msg.fromEmail);
      const classification = InboxService.classify(msg.subject, msg.fromEmail, msg.bodyText, !!contact, myRole === "cc");
      if (classification === "bounce") {
        const bkey = `${msg.subject}|${msg.fromEmail}|${msg.date}`;
        if (bounceSeen.has(bkey)) continue;
        bounceSeen.add(bkey);
      }
      const relatedContactIds = InboxService.matchContactIds([...msg.to, ...msg.cc]);

      getDb().insert(inboxMessages).values({
        accountId,
        messageId: uid,
        fromEmail: msg.fromEmail,
        fromName: msg.fromName,
        subject: msg.subject,
        bodyPreview: msg.bodyText.slice(0, 500),
        classification,
        cc: msg.cc.join(", "),
        myRole,
        matchedContactId: contact?.id || null,
        relatedContactIds,
        receivedAt: msg.date,
      }).run();
      await InboxService.writeBodyForLastInsert(msg.bodyHtml); // 正文落盘文件

      parsed.push({
        id: 0, accountId,
        messageId: uid,
        fromEmail: msg.fromEmail,
        fromName: msg.fromName,
        subject: msg.subject,
        bodyPreview: msg.bodyText.slice(0, 500),
        classification,
        cc: msg.cc.join(", "),
        myRole,
        matchedContactId: contact?.id || null,
        relatedContactIds,
        isRead: 0,
        receivedAt: msg.date,
        createdAt: new Date().toISOString(),
      });
    }

    if (parsed.length > 0) saveDatabase();
    sock.write("QUIT\r\n");
    sock.destroy();
    Log.info("inbox.pop3", `${account.email}: ${parsed.length} 封新邮件`);
    return okResult(parsed);
  } catch (err: unknown) {
    try { sock?.destroy(); } catch { /* */ }
    const msg = err instanceof Error ? err.message : String(err);
    Log.error("inbox.pop3", msg);
    return failResult(msg);
  }
}

// ── IMAP 抓取（原有逻辑）──

async function doImapFetch(accountId: number): Promise<Result<InboxService.InboxMessageRow[]>> {
  const account = getDb().select().from(emailAccounts).where(eq(emailAccounts.id, accountId)).get();
  if (!account) return failResult("账号未找到");
  if (!account.imapHost) return failResult("未配置 IMAP");

  const passRes = getDecryptedPassword(account.id);
  if (!passRes.success) return failResult("账号密码解密失败: " + passRes.error);

  Log.debug("inbox.imap", `连接 ${account.email}`);

  let client: imapflow.ImapFlow | null = null;
  try {
    client = new imapflow.ImapFlow({
      host: account.imapHost, port: account.imapPort || 993,
      secure: (account.imapPort || 993) === 993,
      auth: { user: account.email, pass: passRes.data },
      logger: false,
    });
    await client.connect();
    await client.mailboxOpen("INBOX");

    // 拉近 FETCH_DAYS 天：SEARCH SINCE 按时间窗口，替代 uid 增量（+1 天缓冲时区差）
    const since = new Date(Date.now() - (FETCH_DAYS + 1) * 86400_000);
    const uids = (await client.search({ since }, { uid: true })) || [];
    Log.info("inbox.imap", `${account.email}: 近 ${FETCH_DAYS} 天共 ${uids.length} 封`);
    if (uids.length === 0) {
      await client!.logout();
      client = null;
      return okResult([]);
    }

    // 拉信封（不拉 source，正文懒加载）— 流式处理，逐封插入不阻塞
    const parsed: InboxService.InboxMessageRow[] = [];
    let scanned = 0;
    let inserted = 0;

    // 一次性载入已存在 messageId → 内存 Set，避免逐封查库（拉全部时关键）
    const existing = new Set(
      getDb().select({ messageId: inboxMessages.messageId })
        .from(inboxMessages)
        .where(eq(inboxMessages.accountId, accountId))
        .all()
        .map(r => r.messageId)
        .filter((x): x is string => !!x)
    );

    // 退信去重：退信服务同一秒批量发多封相同 subject/发件人/时间的退信（messageId 各不相同），只留一封
    const bounceSeen = new Set<string>();
    const bounceUids: number[] = []; // 本轮新增的退信 uid，扫完后复用同一连接批量拉原文
    const stream = client.fetch(uids, { uid: true, envelope: true }, { uid: true });
    for await (const msg of stream) {
      scanned++;

      const env = msg.envelope as Record<string, unknown>;
      const msgId = (env.messageId as string) || null;
      const from = (env.from as Array<{ address?: string; name?: string }>)?.[0];
      const fromEmail = from?.address || "unknown";
      const fromName = from?.name || null;
      const subject = (env.subject as string) || null;
      const date = env.date ? new Date(env.date as string).toISOString() : new Date().toISOString();

      // 去重 + 已删除集过滤
      if (msgId && InboxService.isDeleted(`${accountId}|${msgId}`)) continue;
      if (msgId && existing.has(msgId)) continue;

      // 我方角色：直接收件（to）还是仅被抄送（cc）
      const toArr = (env.to as Array<{ address?: string }>) || [];
      const ccArr = (env.cc as Array<{ address?: string }>) || [];
      const myEmail = account.email.toLowerCase();
      const myRole = toArr.some(a => (a.address || "").toLowerCase() === myEmail) ? "to"
        : ccArr.some(a => (a.address || "").toLowerCase() === myEmail) ? "cc" : null;
      const ccList = ccArr.map(a => a.address || "").filter(Boolean).join(", ");

      // 元数据阶段：正文留空，正文懒加载时再补（避免每封拉 source 卡顿）
      const contact = InboxService.matchContact(fromEmail);
      const classification = InboxService.classify(subject, fromEmail, "", !!contact, myRole === "cc");
      if (classification === "bounce") {
        const bkey = `${subject}|${fromEmail}|${date}`;
        if (bounceSeen.has(bkey)) continue;
        bounceSeen.add(bkey);
        // 退信必须拉原文才能知道退的是谁（from 是 mailer-daemon），先记 uid，扫完统一批量拉
        if (msg.uid) bounceUids.push(msg.uid);
      }
      const relatedContactIds = InboxService.matchContactIds(
        [...toArr, ...ccArr].map(a => a.address || "").filter(Boolean),
      );

      getDb().insert(inboxMessages).values({
        accountId, messageId: msgId,
        fromEmail, fromName, subject,
        bodyPreview: "", classification,
        cc: ccList, myRole,
        matchedContactId: contact?.id || null,
        relatedContactIds,
        receivedAt: date,
      }).run();
      if (msgId) existing.add(msgId);
      inserted++;

      parsed.push({
        id: 0, accountId, messageId: msgId,
        fromEmail, fromName, subject,
        bodyPreview: "", classification,
        cc: ccList, myRole,
        matchedContactId: contact?.id || null,
        relatedContactIds,
        isRead: 0, receivedAt: date,
        createdAt: new Date().toISOString(),
      });

      if (scanned % 25 === 0) pushProgress(accountId, scanned, uids.length, account.email);
    }

    if (inserted > 0) saveDatabase();
    pushProgress(accountId, scanned, uids.length, account.email);
    Log.info("inbox.imap", `${account.email}: 扫描 ${scanned} 封，新增 ${inserted} 封`);

    // ── 退信原文补全 ──
    // 元数据阶段只拉了信封，而退信的 from 是 mailer-daemon，被退地址只在原文（含 DSN 段）里。
    // 复用同一个连接批量拉一次 source，当场提取联系人并落正文，省掉事后逐封重连的开销。
    if (bounceUids.length > 0) {
      let matched = 0;
      try {
        const bStream = client.fetch(bounceUids, { uid: true, source: true, envelope: true }, { uid: true });
        for await (const bm of bStream) {
          const bMsgId = ((bm.envelope as Record<string, unknown>)?.messageId as string) || null;
          if (!bMsgId || !bm.source) continue;
          const raw = await parseRawEmail(bm.source as Buffer);
          if (!raw) continue;
          const hit = await InboxService.applyBounceSource(
            bMsgId, accountId, bm.source.toString(),
            raw.bodyHtml || raw.bodyText || "", raw.bodyText || "",
          );
          if (hit) matched++;
        }
        saveDatabase();
        Log.info("inbox.bounce", `${account.email}: 退信 ${bounceUids.length} 封，匹配到联系人 ${matched} 封`);
      } catch (err) {
        Log.warn("inbox.bounce", `退信原文拉取失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await client!.logout();
    client = null;
    return okResult(parsed);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    Log.error("inbox.imap", msg, err instanceof Error ? err.stack : undefined);
    if (client) { try { client.logout(); } catch { /* */ } }
    return failResult(msg);
  }
}

// ── 存量退信深度补拉 ──

/** 常规抓取只覆盖近 FETCH_DAYS 天，更早的存量退信匹配不到联系人只能靠这个补。
 *  按待补退信的最早日期开窗 search，一个连接内建 messageId→uid 映射再批量拉原文。
 *  限量 + 幂等：补上的下次不再进候选，多跑几次自然补完。 */
async function backfillBounceDeep(accountId: number, limit = 100): Promise<number> {
  const account = getDb().select().from(emailAccounts).where(eq(emailAccounts.id, accountId)).get();
  if (!account?.imapHost) return 0;
  if (isPop3Port(account.imapPort || 993)) return 0; // POP3 抓取时已有全文，无需补

  const targets = getDb().select({ messageId: inboxMessages.messageId, receivedAt: inboxMessages.receivedAt })
    .from(inboxMessages)
    .where(sql`${inboxMessages.classification} = 'bounce'
               AND ${inboxMessages.matchedContactId} IS NULL
               AND ${inboxMessages.accountId} = ${accountId}
               AND ${inboxMessages.messageId} IS NOT NULL`)
    .orderBy(sql`${inboxMessages.receivedAt} DESC`)
    .limit(limit)
    .all();
  if (targets.length === 0) return 0;

  const wanted = new Set<string>();
  let earliest = targets[0]!.receivedAt;
  for (const t of targets) {
    if (t.messageId) wanted.add(t.messageId);
    if (t.receivedAt < earliest) earliest = t.receivedAt;
  }

  const passRes = getDecryptedPassword(account.id);
  if (!passRes.success) return 0;

  let client: imapflow.ImapFlow | null = null;
  try {
    const port = account.imapPort || 993;
    client = new imapflow.ImapFlow({
      host: account.imapHost, port, secure: port === 993,
      auth: { user: account.email, pass: passRes.data },
      logger: false,
    });
    await client.connect();
    await client.mailboxOpen("INBOX");

    const since = new Date(new Date(earliest).getTime() - 86400_000); // 缓冲 1 天防时区差
    const uids = (await client.search({ since }, { uid: true })) || [];
    if (uids.length === 0) return 0;

    // 先只拉信封定位目标（信封很轻，几千封也快），避免把整个窗口的正文都拖下来
    const hitUids: number[] = [];
    for await (const m of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
      const mid = ((m.envelope as Record<string, unknown>)?.messageId as string) || null;
      if (mid && wanted.has(mid) && m.uid) hitUids.push(m.uid);
    }
    if (hitUids.length === 0) return 0;

    let matched = 0;
    for await (const bm of client.fetch(hitUids, { uid: true, source: true, envelope: true }, { uid: true })) {
      const mid = ((bm.envelope as Record<string, unknown>)?.messageId as string) || null;
      if (!mid || !bm.source) continue;
      const raw = await parseRawEmail(bm.source as Buffer);
      if (!raw) continue;
      const hit = await InboxService.applyBounceSource(
        mid, accountId, bm.source.toString(),
        raw.bodyHtml || raw.bodyText || "", raw.bodyText || "",
      );
      if (hit) matched++;
    }
    saveDatabase();
    Log.info("inbox.bounceDeep", `${account.email}: 待补 ${targets.length} 封，命中 ${hitUids.length} 封，新匹配 ${matched} 个联系人`);
    return matched;
  } catch (err: unknown) {
    Log.warn("inbox.bounceDeep", `${account.email} 补拉失败: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  } finally {
    if (client) { try { client.logout(); } catch { /* 已断开 */ } }
  }
}

// ── 后台 Sent 检测（不阻塞 INBOX 返回）──

async function detectSent(accountId: number): Promise<number> {
  const account = getDb().select().from(emailAccounts).where(eq(emailAccounts.id, accountId)).get();
  if (!account?.imapHost) { Log.warn("inbox.sent", `跳过: 无IMAP配置`); return 0; }
  const port = account.imapPort || 993;
  if (isPop3Port(port)) { Log.warn("inbox.sent", `跳过: POP3端口`); return 0; }
  const passRes = getDecryptedPassword(account.id);
  if (!passRes.success) { Log.warn("inbox.sent", `跳过: 密码解密失败`); return 0; }
  Log.debug("inbox.sent", `开始检测 ${account.email}`);

  let client: imapflow.ImapFlow | null = null;
  try {
    client = new imapflow.ImapFlow({
      host: account.imapHost, port, secure: port === 993,
      auth: { user: account.email, pass: passRes.data },
      logger: false,
    });
    await client.connect();
    const sentMailbox = await findSentMailbox(client);
    if (!sentMailbox) { Log.warn("inbox.sent", `${account.email}: 未找到 Sent 文件夹`); return 0; }
    await client.mailboxOpen(sentMailbox);
    // 拉近 FETCH_DAYS 天（+1 天缓冲时区差）
    const since = new Date(Date.now() - (FETCH_DAYS + 1) * 86400_000);
    const sentUids = (await client.search({ since }, { uid: true })) || [];
    Log.info("inbox.sent", `${account.email}: Sent 文件夹「${sentMailbox}」近 ${FETCH_DAYS} 天 ${sentUids.length} 封`);

    // 拉 sent 信封（不拉 source，正文懒加载）
    const existing = new Set(
      getDb().select({ messageId: inboxMessages.messageId })
        .from(inboxMessages)
        .where(eq(inboxMessages.accountId, accountId))
        .all()
        .map(r => r.messageId)
        .filter((x): x is string => !!x)
    );
    const stream = client.fetch(sentUids, { uid: true, envelope: true, source: true }, { uid: true });
    let scanned = 0, added = 0;
    for await (const msg of stream) {
      scanned++;
      const env = msg.envelope as Record<string, unknown>;
      const msgId = (env.messageId as string) || null;
      if (!msgId) continue;
      if (InboxService.isDeleted(`${accountId}|${msgId}`)) continue;
      if (existing.has(msgId)) continue;
      // 额外查数据库防并发 detectSent 重复写入（内存 existing 只在 stream 前查一次）
      const dup = getDb().select({ id: inboxMessages.id })
        .from(inboxMessages)
        .where(and(eq(inboxMessages.messageId, msgId), eq(inboxMessages.accountId, accountId)))
        .get();
      if (dup) continue;
      // 收件人：BCC 邮件的收件人在 bcc 不在 to，to+cc+bcc 全解析
      const toArr = (env.to as Array<{ address?: string; name?: string }>) || [];
      const ccArr = (env.cc as Array<{ address?: string; name?: string }>) || [];
      const bccArr = (env.bcc as Array<{ address?: string; name?: string }>) || [];
      const allRecipients = [...toArr, ...ccArr, ...bccArr].map(a => a.address || "").filter(Boolean);
      if (allRecipients.length === 0) continue;

      const subject = (env.subject as string) || "";
      const recipientsStr = allRecipients.join(", ");

      // 匹配所有联系人（去重），主联系人取第一个
      const matchedIds = new Set<number>();
      for (const email of allRecipients) {
        const c = InboxService.matchContact(email);
        if (c) matchedIds.add(c.id);
      }
      const contactIds = [...matchedIds];
      const primaryContactId = contactIds[0] || null;

      getDb().insert(inboxMessages).values({
        accountId, messageId: msgId,
        fromEmail: account.email, fromName: account.displayName || null, subject,
        bodyPreview: `发给: ${recipientsStr}`, // 元数据占位，正文懒加载时再补
        classification: "sent",
        matchedContactId: primaryContactId,
        relatedContactIds: contactIds.join(","),
        isRead: 0, receivedAt: env.date ? new Date(env.date as string | Date).toISOString() : new Date().toISOString(),
      }).run();
      // 正文直接落盘文件（已拉 source，避免懒加载搜索 messageId 失败导致无正文）
      if (msg.source) {
        try {
          const raw = await parseRawEmail(msg.source as Buffer);
          if (raw) {
            await InboxService.writeBodyForLastInsert(raw.bodyHtml || raw.bodyText || "");
            getDb().update(inboxMessages)
              .set({ bodyPreview: raw.bodyText.slice(0, 500) })
              .where(and(eq(inboxMessages.messageId, msgId), eq(inboxMessages.accountId, accountId)))
              .run();
          }
        } catch { /* 单封正文解析失败跳过 */ }
      }
      existing.add(msgId);
      added++;
      // 每个匹配的联系人都写互动记录（BCC 多人全对应）
      for (const cid of contactIds) {
        getDb().insert(interactions).values({
          contactId: cid, type: "sent", direction: "outbound",
          subject, bodyPreview: `已发送至 ${recipientsStr}`,
          messageId: msgId, accountId,
        }).run();
      }
    }
    if (added > 0) { saveDatabase(); }
    Log.info("inbox.sent", `${account.email}: 扫描 ${scanned} 封，新增 ${added} 封`);
    return added;
  } catch (err) {
    Log.warn("inbox.sent", `${account.email} 检测失败: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  } finally {
    if (client) { try { client.logout(); } catch { /* */ } }
  }
}

// ── 统一抓取入口（自动选择 IMAP/POP3）──

async function doFetch(accountId: number): Promise<Result<InboxService.InboxMessageRow[]>> {
  const account = getDb().select().from(emailAccounts).where(eq(emailAccounts.id, accountId)).get();
  if (!account) return failResult("账号未找到");
  const port = account.imapPort || 993;
  if (isPop3Port(port)) return doPop3Fetch(accountId);
  return doImapFetch(accountId);
}

function createPushFn() {
  return (channel: string, data: unknown) => {
    try { BrowserWindow.getAllWindows()[0]?.webContents.send(channel, data); } catch { /* */ }
  };
}

// ── 正文懒加载：按 messageId 从 IMAP SEARCH 定位 + 拉单封 source ──

let _pushToRenderer: ((channel: string, data: unknown) => void) | null = null;

function pushProgress(accountId: number, scanned: number, total: number, email?: string): void {
  try { _pushToRenderer?.("inbox:fetchProgress", { accountId, email, scanned, total }); } catch { /* */ }
}

// 定位 Sent 文件夹：优先 specialUse=\Sent 标记，兜底常见名字（阿里邮箱中文名「已发送」）
async function findSentMailbox(client: imapflow.ImapFlow): Promise<string | null> {
  try {
    const list = await client.list();
    for (const m of list) {
      const su = ((m as { specialUse?: string }).specialUse || "");
      if (su.includes("\\Sent")) return m.path;
    }
    const names = ["Sent", "Sent Items", "Sent Mail", "Gesendet", "Enviados", "已发送", "已发送邮件"];
    for (const m of list) {
      if (names.includes(m.name) || names.includes(m.path)) return m.path;
    }
  } catch { /* list 失败 → 返回 null */ }
  return null;
}

async function fetchBody(accountId: number, messageId: string, classification?: string | null): Promise<Result<string>> {
  const account = getDb().select().from(emailAccounts).where(eq(emailAccounts.id, accountId)).get();
  if (!account?.imapHost) return failResult("未配置 IMAP");
  if (isPop3Port(account.imapPort || 993)) return failResult("POP3 不支持按需拉取正文");
  const passRes = getDecryptedPassword(account.id);
  if (!passRes.success) return failResult("密码解密失败: " + passRes.error);

  let client: imapflow.ImapFlow | null = null;
  try {
    client = new imapflow.ImapFlow({
      host: account.imapHost, port: account.imapPort || 993,
      secure: (account.imapPort || 993) === 993,
      auth: { user: account.email, pass: passRes.data },
      logger: false,
    });
    await client.connect();
    // sent 邮件在「已发送」文件夹，其他在 INBOX
    const mailbox = classification === "sent" ? (await findSentMailbox(client) || "INBOX") : "INBOX";
    await client.mailboxOpen(mailbox);

    // 关键：search 默认返回 sequence number，必须 { uid: true } 返回 UID，否则 fetch(uid) 会拉到错误的邮件
    const uids = await client.search({ header: { "message-id": messageId } }, { uid: true });
    if (!uids || uids.length === 0) return failResult("服务器未找到该邮件正文");
    const uid = uids[uids.length - 1]!;

    const stream = client.fetch(String(uid), { uid: true, source: true }, { uid: true });
    for await (const msg of stream) {
      const raw = await parseRawEmail(msg.source as Buffer);
      if (!raw) return failResult("正文解析失败");
      const html = raw.bodyHtml || raw.bodyText || "";
      // 正文落盘文件（不进库）；bodyPreview 截断保留在库用于列表预览
      const target = getDb().select({
        id: inboxMessages.id, subject: inboxMessages.subject,
        fromEmail: inboxMessages.fromEmail, classification: inboxMessages.classification,
        matchedContactId: inboxMessages.matchedContactId,
      }).from(inboxMessages)
        .where(and(eq(inboxMessages.messageId, messageId), eq(inboxMessages.accountId, accountId)))
        .get();
      if (target) {
        await InboxService.writeBodyFile(target.id, html);
        // 重新分类：正文拉到后，基于正文的退信/自动回复检测才准确（元数据阶段 bodyText 为空）；sent 邮件不重分
        const reClass = target.classification !== "sent"
          ? InboxService.classify(target.subject, target.fromEmail, raw.bodyText, !!target.matchedContactId)
          : target.classification;
        // 正文匹配联系人：退信等 from 匹配不到（mailer-daemon）的情况，从正文提取被退/被抄送的联系人邮箱
        let matchedId = target.matchedContactId;
        if (matchedId == null) {
          // 传 raw 原文：DSN 段（Final-Recipient 等）只在原文里，mailparser 会把它归到 attachments
          matchedId = InboxService.extractBouncedContact(
            `${msg.source?.toString() || ""}\n${raw.bodyText || ""}\n${html}`,
          );
        }
        getDb().update(inboxMessages)
          .set({
            bodyPreview: raw.bodyText.slice(0, 500),
            ...(reClass !== target.classification ? { classification: reClass } : {}),
            ...(matchedId != null && matchedId !== target.matchedContactId ? { matchedContactId: matchedId } : {}),
          })
          .where(eq(inboxMessages.id, target.id))
          .run();
        saveDatabase();
      }
      return okResult(html);
    }
    return failResult("未拉取到正文");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    Log.warn("inbox.body", `${account.email} 正文拉取失败: ${msg}`);
    return failResult(msg);
  } finally {
    if (client) { try { client.logout(); } catch { /* */ } }
  }
}

export function registerInboxIPC() {
  InboxService.setImapFetchFn(doFetch);
  InboxService.setImapFetchBodyFn(fetchBody);
  InboxService.setInboxPushFn(createPushFn());
  _pushToRenderer = createPushFn();
  InboxService.startAutoFetch();

  ipcMain.handle(IPC.INBOX.LIST, async () => {
    return InboxService.listInbox();
  });
  ipcMain.handle(IPC.INBOX.FETCH, async (_e, accountId?: number) => {
    await InboxService.fetchInbox(accountId);
    InboxService.cleanupInbox();
    // 后台预加载前 20 封正文（不阻塞返回，读条结束后前端即可秒开前 20 封）
    void InboxService.prefetchRecentBodies(20);
    // 后台补匹配退信联系人：先扫本地正文（免费），再对更早的存量走 IMAP 深度补拉。
    // 串行执行，避免和 prefetch/detectSent 叠加过多 IMAP 连接。
    void (async () => {
      let n = await InboxService.backfillBounceMatches();
      const targets = accountId
        ? [accountId]
        : getDb().select({ id: emailAccounts.id }).from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all().map(a => a.id);
      for (const aid of targets) n += await backfillBounceDeep(aid);
      if (n > 0) BrowserWindow.getAllWindows()[0]?.webContents.send("inbox:newMail", { count: 0 });
    })().catch(err => Log.error("inbox.backfill", "退信补匹配失败", err instanceof Error ? err.stack : undefined));
    // 后台检测 Sent 文件夹（不阻塞返回，完成后推送通知刷新前端）
    const accounts = getDb().select().from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all();
    const sentTargets = accounts.filter(a => !isPop3Port(a.imapPort || 993));
    Log.debug("inbox.sent", `将检测 ${sentTargets.length}/${accounts.length} 个账号`);
    Promise.allSettled(sentTargets.map(a => detectSent(a.id))).then((results) => {
      const totalNew = results.reduce((sum, r) => {
        return sum + (r.status === "fulfilled" ? (r.value || 0) : 0);
      }, 0);
      if (totalNew > 0) {
        try {
          InboxService.cleanupInbox();
          BrowserWindow.getAllWindows()[0]?.webContents.send("inbox:newMail", { count: totalNew });
        } catch { /* */ }
      }
    });
    return InboxService.listInbox();
  });
  ipcMain.handle(IPC.INBOX.CLASSIFY, async (_e, payload: { id: number; classification: string }) => {
    if (!payload?.id || !payload?.classification) return failResult("参数错误");
    return InboxService.classifyMessage(payload.id, payload.classification);
  });
  ipcMain.handle(IPC.INBOX.MARK_READ, async (_e, id: number) => {
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误");
    return InboxService.markRead(id);
  });
  ipcMain.handle(IPC.INBOX.DELETE, async (_e, id: number) => {
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误");
    return InboxService.deleteMessage(id);
  });
  ipcMain.handle(IPC.INBOX.DELETE_BOUNCE, async () => {
    return InboxService.deleteAllBounce();
  });
  ipcMain.handle(IPC.INBOX.GET_BODY, async (_e, id: number) => {
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误");
    return await InboxService.getBody(id);
  });
}

export function cleanupInboxIPC() {
  InboxService.stopAutoFetch();
}
