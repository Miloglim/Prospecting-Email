"use strict";
const electron = require("electron");
const api = {
  invoke: (channel, ...args) => electron.ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => electron.ipcRenderer.send(channel, ...args),
  on: (channel, callback) => {
    const handler = (_event, ...args) => callback(...args);
    electron.ipcRenderer.on(channel, handler);
    return () => {
      electron.ipcRenderer.removeListener(channel, handler);
    };
  }
};
electron.contextBridge.exposeInMainWorld("api", api);
