import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as Kb from "../services/kb.service";
import { failResult } from "../errors";
import { Log } from "../logger";

export function registerKbIPC() {
  // 读取 KB 中转配置（不含明文令牌）
  ipcMain.handle(IPC.KB.CONFIG_GET, () => Kb.getKbConfig());

  // 写入/清除配置（空串=清除），落到 .env，本次运行即时生效
  ipcMain.handle(IPC.KB.CONFIG_SET, (_e, input: { baseUrl?: string; token?: string; applicationId?: string }) => {
    if (!input || (input.baseUrl === undefined && input.token === undefined && input.applicationId === undefined)) {
      return failResult("缺少要写入的配置项");
    }
    return Kb.setKbConfig(input);
  });

  // 离线预览：返回将发出的真实请求（令牌脱敏），用于验证两层鉴权是否串位
  ipcMain.handle(IPC.KB.PREVIEW, (_e, input: Kb.KbRequestInput) => {
    if (!input?.method) return failResult("缺少 method");
    return Kb.kbPreview(input);
  });

  // 连通性 + 鉴权探针（无需真实业务接口，返回 reachable/verdict/hint）
  ipcMain.handle(IPC.KB.TEST_CONNECTION, async () => {
    Log.debug("kb.ipc", "testConnection");
    return await Kb.kbTestConnection();
  });

  // 实际发起一次 http-dispatch 中转调用
  ipcMain.handle(IPC.KB.DISPATCH, async (_e, input: Kb.KbRequestInput) => {
    if (!input?.method) return failResult("缺少 method");
    Log.debug("kb.ipc", `dispatch ${input.method} ${input.url || `${input.applicationId}${input.path || ""}`}`);
    return await Kb.kbDispatch(input);
  });
}
