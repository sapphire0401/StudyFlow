// Electron Forge 打包配置
// 目标：Windows x64 安装包（Squirrel.Windows，自带桌面 + 开始菜单快捷方式）
const path = require("path");

module.exports = {
  packagerConfig: {
    // 稳定的应用标识与产物命名：StudyFlow.exe / StudyFlow
    name: "StudyFlow",
    executableName: "StudyFlow",
    // 应用（StudyFlow.exe）图标：由 tray-icon.png 生成的多尺寸 icon.ico
    icon: path.join(__dirname, "icon"),
    // 稳定 appId（升级/重装保持一致，避免系统把它当成另一个应用）
    appBundleId: "com.studyflow.app",
    appCopyright: "Copyright © 2026 StudyFlow",
    asar: true,
    // 只打包运行所需文件，排除构建产物、锁文件与验证脚本
    ignore: [
      /^\/out($|\/)/,
      /^\/\.git($|\/)/,
      /^\/package-lock\.json$/,
      /^\/_verify.*\.js$/,
      /^\/node_modules\/\.cache($|\/)/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        // 安装标识（决定 %LOCALAPPDATA% 安装目录与卸载注册项），跨版本保持稳定
        name: "StudyFlow",
        authors: "StudyFlow",
        description: "StudyFlow 学习记录桌面组件",
        // 安装程序与快捷方式图标（多尺寸 icon.ico）
        setupIcon: path.join(__dirname, "icon.ico"),
      },
    },
  ],
};
