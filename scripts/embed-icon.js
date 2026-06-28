// electron-builder afterPack hook: 手动嵌入图标
exports.default = async function(context) {
  const path = require('path');
  const { rcedit } = await import('rcedit');
  const exeName = context.packager.appInfo.productFilename + '.exe';
  const exePath = path.join(context.appOutDir, exeName);
  const icoPath = path.join(__dirname, '..', 'build', 'icon.ico');
  console.log('Embedding icon:', icoPath, '→', exePath);
  await rcedit(exePath, { icon: icoPath });
  console.log('Icon embedded!');
};
