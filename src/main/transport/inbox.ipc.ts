import { ipcMain, BrowserWindow } from "electron";
import * as imapflow from "imapflow";
import { IPC } from "../contract";
import * as InboxService from "../services/inbox.service";
import { Log } from "../logger";
import { failResult, okResult } from "../errors";
import { getDb } from "../db";
import { inboxMessages } from "../db/schema/inbox";
import { emailAccounts } from "../db/schema/accounts";
import { eq } from "drizzle-orm";
import { saveDatabase } from "../db";

async function doImapFetch(accountId: number) {
  const account = getDb().select().from(emailAccounts).where(eq(emailAccounts.id, accountId)).get();
  if (!account) return failResult("账号未找到");
  if (!account.imapHost) return failResult("未配置 IMAP");

  Log.debug("inbox.imap", `连接 ${account.email}`);

  let client: imapflow.ImapFlow | null = null;
  try {
    client = new imapflow.ImapFlow({
      host: account.imapHost, port: account.imapPort || 993,
      secure: (account.imapPort || 993) === 993,
      auth: { user: account.email, pass: account.encryptedPass },
      logger: false,
    });
    await client.connect();
    await client.mailboxOpen("INBOX");

    const messages: imapflow.FetchMessageObject[] = [];
    const stream = client.fetch({ seen: false }, {
      uid: true, envelope: true, source: { maxLength: 50000 },
    });

    let count = 0;
    for await (const msg of stream) {
      if (count++ >= 50) break;
      messages.push(msg);
    }

    await client.logout();
    client = null;

    const parsed: InboxService.InboxMessageRow[] = [];
    for (const msg of messages) {
      const env = msg.envelope as Record<string, unknown>;
      const from = (env.from as Array<{ address?: string; name?: string }>)?.[0];
      const fromEmail = from?.address || "unknown";
      const fromName = from?.name || null;
      const subject = (env.subject as string) || null;
      const msgId = (env.messageId as string) || null;

      let bodyPreview = "";
      try { bodyPreview = (msg.source as Buffer).toString("utf-8").slice(0, 500); } catch { /* */ }

      const classification = InboxService.classify(subject, fromEmail, bodyPreview);
      const contact = InboxService.matchContact(fromEmail);

      // 去重
      if (msgId) {
        const exist = getDb().select().from(inboxMessages).where(eq(inboxMessages.messageId, msgId)).get();
        if (exist) continue;
      }

      getDb().insert(inboxMessages).values({
        accountId, messageId: msgId, fromEmail, fromName, subject,
        bodyPreview, classification,
        matchedContactId: contact?.id || null,
        receivedAt: new Date().toISOString(),
      }).run();

      parsed.push({
        id: 0, accountId, messageId: msgId, fromEmail, fromName,
        subject, bodyPreview, classification,
        matchedContactId: contact?.id || null,
        isRead: 0, receivedAt: new Date().toISOString(),
        rawSource: null, createdAt: new Date().toISOString(),
      });
    }

    if (parsed.length > 0) saveDatabase();
    Log.info("inbox.imap", `${account.email}: ${parsed.length} 封`);
    return okResult(parsed);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    Log.error("inbox.imap", msg, err instanceof Error ? err.stack : undefined);
    if (client) { try { client.logout(); } catch { /* */ } }
    return failResult(msg);
  }
}

function createPushFn() {
  return (channel: string, data: unknown) => {
    try { BrowserWindow.getAllWindows()[0]?.webContents.send(channel, data); } catch { /* */ }
  };
}

export function registerInboxIPC() {
  InboxService.setImapFetchFn(doImapFetch);
  InboxService.setInboxPushFn(createPushFn());
  InboxService.startAutoFetch();

  ipcMain.handle(IPC.INBOX.FETCH, async (_e, accountId?: number) => {
    const fetched = await InboxService.fetchInbox(accountId);
    if (fetched.success && fetched.data.length > 0) return fetched;
    // 没抓到新邮件 → 返回 DB 已有邮件
    return InboxService.listInbox();
  });
  ipcMain.handle(IPC.INBOX.CLASSIFY, async (_e, payload: { id: number; classification: string }) => {
    if (!payload?.id || !payload?.classification) return failResult("参数错误");
    return InboxService.classifyMessage(payload.id, payload.classification);
  });
}

export function cleanupInboxIPC() {
  InboxService.stopAutoFetch();
}
