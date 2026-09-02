import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../main/contract";
import { EVENTS } from "../main/events";

// ── P0-4 通道白名单：渲染端只能触达 contract/events 里声明的通道 ──
// preload 与主进程共享同一份通道常量源（纯 TS 常量，无 electron 依赖，可安全打进 preload 包）。
// 未在白名单内的通道名直接抛错 —— 渲染端被注入脚本后也无法探测其余 ipcMain handler。
const invokeChannels = new Set<string>(
  Object.values(IPC).flatMap((group) => Object.values(group as Record<string, string>)),
);
const eventChannels = new Set<string>(Object.values(EVENTS));
const sendChannels = new Set<string>(["window:minimize", "window:maximize", "window:close"]);

const api = {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!invokeChannels.has(channel)) throw new Error(`IPC 通道未授权: ${channel}`);
    return ipcRenderer.invoke(channel, ...args);
  },
  send: (channel: string, ...args: unknown[]) => {
    if (!sendChannels.has(channel)) throw new Error(`IPC 通道未授权: ${channel}`);
    ipcRenderer.send(channel, ...args);
  },
  on: (channel: string, callback: (...args: unknown[]) => void) => {
    if (!eventChannels.has(channel)) throw new Error(`事件通道未授权: ${channel}`);
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.removeListener(channel, handler); };
  },
} as const;

contextBridge.exposeInMainWorld("api", api);

export type ElectronAPI = typeof api;
