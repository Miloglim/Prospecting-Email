import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as AccountService from "../services/account.service";
import * as SenderBlock from "../services/sender-block.service";
import * as SendService from "../services/send.service";
import { Log } from "../logger";
import { failResult } from "../errors";

export function registerAccountIPC() {
  ipcMain.handle(IPC.ACCOUNTS.LIST, () => {
    Log.debug("ipc.accounts.list", "");
    return AccountService.listAccounts();
  });

  ipcMain.handle(IPC.ACCOUNTS.UPSERT, async (_e, input) => {
    Log.debug("ipc.accounts.upsert", `email=${input?.email}`);
    if (!input?.email || !input?.smtpHost) {
      return failResult("参数错误: email、smtpHost 必填");
    }
    // ponytail: 编辑时可不传密码，service 层做最终校验
    return AccountService.upsertAccount(input);
  });

  ipcMain.handle(IPC.ACCOUNTS.DELETE, async (_e, id: number) => {
    Log.debug("ipc.accounts.delete", `id=${id}`);
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误: 无效的 id");
    return AccountService.deleteAccount(id);
  });

  ipcMain.handle(IPC.ACCOUNTS.VALIDATE, async (_e, id: number) => {
    Log.debug("ipc.accounts.validate", `id=${id}`);
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误: 无效的 id");
    return AccountService.validateAccount(id);
  });

  // 一键解除发信熔断（用户在设置页账号卡显式点击才写盘）：清熔断三列 + 连续失败计数，
  // 并播报熔断态变化让队列页/账号卡立即回绿（规范 docs/sender-block-circuit-spec.md §6）
  ipcMain.handle(IPC.ACCOUNTS.RESET_CIRCUIT, async (_e, id: number) => {
    Log.debug("ipc.accounts.resetCircuit", `id=${id}`);
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误: 无效的 id");
    const r = SenderBlock.resetSendCircuit(id);
    if (r.success) SendService.pushCircuitChanged({ accountId: id, reason: "reset" });
    return r;
  });
}
