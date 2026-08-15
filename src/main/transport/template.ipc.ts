import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as svc from "../services/template.service";
import { PRESET_TEMPLATES } from "../services/presetTemplates";
import { Log } from "../logger";
import { failResult } from "../errors";

export function registerTemplateIPC() {
  ipcMain.handle(IPC.TEMPLATES.PRESETS, () => ({ success: true as const, data: PRESET_TEMPLATES }));

  ipcMain.handle(IPC.TEMPLATES.LIST, async (_e, language?: string) => {
    Log.debug("ipc.template.list", `language=${language}`);
    return svc.listTemplates(language);
  });

  ipcMain.handle(IPC.TEMPLATES.UPSERT, async (_e, input) => {
    Log.debug("ipc.template.upsert", `name=${input?.name}`);
    if (!input?.name || !input?.subject || !input?.body) {
      return failResult("参数错误: name、subject、body 必填");
    }
    return svc.upsertTemplate(input);
  });

  ipcMain.handle(IPC.TEMPLATES.DELETE, async (_e, id: number) => {
    Log.debug("ipc.template.delete", `id=${id}`);
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误: 无效的 id");
    return svc.deleteTemplate(id);
  });
}
