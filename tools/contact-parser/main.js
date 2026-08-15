// ponytail: minimal Electron wrapper — loads the HTML, that's it
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1100, height: 700, title: 'Contact Parser' });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
});
