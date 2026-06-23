import type { Language } from "../../shared/types";

const zh = {
  appName: "Highseas WebSSH", productName: "Cloudflare Edge 工作台", connections: "服务器", connect: "连接", disconnect: "断开",
  editConnection: "编辑服务器", deleteConnection: "删除服务器", saveVps: "添加服务器", updateConnection: "保存修改", saveConnection: "添加并连接",
  name: "名称", host: "IP 或域名", port: "端口", username: "用户名", password: "密码", privateKey: "私钥", sshPassword: "SSH 密码",
  pastePrivateKey: "粘贴私钥或上传 PEM 文件", newVps: "新服务器", noConnection: "尚未连接", selectConnectionHint: "从左侧选择服务器",
  connecting: "正在建立安全连接...", disconnected: "连接已断开", liveStatus: "实时监控", memory: "内存", disk: "磁盘", processes: "进程",
  fileManager: "文件管理", noSshConnection: "连接服务器后可浏览文件", directory: "目录", parentDir: "上级目录", refresh: "刷新", emptyDir: "目录为空",
  uploadFile: "上传", downloadFile: "下载", uploading: "上传中", uploadSuccess: "上传完成", uploadFailed: "上传失败", downloading: "下载中", downloadFailed: "下载失败",
  save: "保存", writeError: "保存失败", savedAt: "已保存", commandHistory: "命令历史", searchHistory: "搜索命令", clearHistory: "清空", emptyHistory: "暂无历史", historyLoadFailed: "历史加载失败",
  language: "语言", languageZh: "中文", languageEn: "English", lightTerminal: "浅色", darkTerminal: "高对比", logout: "退出登录",
  enableTwoFactor: "启用 2FA", twoFactorEnabled: "2FA 已启用", scanQrCode: "使用验证器扫描二维码", manualSecret: "手动密钥", verificationCode: "六位动态码",
  confirmEnable: "确认启用", cancel: "取消", totpSetupFailed: "两步验证设置失败", totpDisableFailed: "无法关闭两步验证", managementPassword: "密码",
  twoFactorCode: "动态验证码", enterConsole: "进入工作台", loginFailed: "登录失败", setupTitle: "创建管理员", setupHint: "首次运行，请创建本机管理员账号",
  quickCommands: "快捷命令", addCommand: "添加命令", commandName: "显示名称", commandText: "命令内容", category: "分类", run: "执行", delete: "删除",
  changePassword: "修改密码", currentPassword: "当前密码", newPassword: "新密码（至少 12 位）", disableTwoFactor: "关闭 2FA", recoveryCodes: "恢复码（仅显示一次）",
  group: "分组", hostFingerprint: "SSH 指纹（建议填写）", uploadPem: "上传 PEM", commandHistorySetting: "记录命令历史"
};

const en: typeof zh = {
  appName: "Highseas WebSSH", productName: "Cloudflare Edge workspace", connections: "Servers", connect: "Connect", disconnect: "Disconnect",
  editConnection: "Edit server", deleteConnection: "Delete server", saveVps: "Add server", updateConnection: "Save changes", saveConnection: "Add and connect",
  name: "Name", host: "IP or hostname", port: "Port", username: "Username", password: "Password", privateKey: "Private key", sshPassword: "SSH password",
  pastePrivateKey: "Paste a private key or upload a PEM file", newVps: "New server", noConnection: "Not connected", selectConnectionHint: "Select a server on the left",
  connecting: "Opening secure connection...", disconnected: "Connection closed", liveStatus: "Live monitor", memory: "Memory", disk: "Disk", processes: "Processes",
  fileManager: "Files", noSshConnection: "Connect to browse files", directory: "Directory", parentDir: "Parent", refresh: "Refresh", emptyDir: "Empty directory",
  uploadFile: "Upload", downloadFile: "Download", uploading: "Uploading", uploadSuccess: "Upload complete", uploadFailed: "Upload failed", downloading: "Downloading", downloadFailed: "Download failed",
  save: "Save", writeError: "Save failed", savedAt: "Saved", commandHistory: "Command history", searchHistory: "Search commands", clearHistory: "Clear", emptyHistory: "No history", historyLoadFailed: "Unable to load history",
  language: "Language", languageZh: "中文", languageEn: "English", lightTerminal: "Light", darkTerminal: "High contrast", logout: "Sign out",
  enableTwoFactor: "Enable 2FA", twoFactorEnabled: "2FA enabled", scanQrCode: "Scan with an authenticator", manualSecret: "Manual secret", verificationCode: "Six-digit code",
  confirmEnable: "Enable", cancel: "Cancel", totpSetupFailed: "Unable to configure 2FA", totpDisableFailed: "Unable to disable 2FA", managementPassword: "Password",
  twoFactorCode: "Authenticator code", enterConsole: "Open workspace", loginFailed: "Login failed", setupTitle: "Create administrator", setupHint: "Create the first local administrator account",
  quickCommands: "Quick commands", addCommand: "Add command", commandName: "Display name", commandText: "Command", category: "Category", run: "Run", delete: "Delete",
  changePassword: "Change password", currentPassword: "Current password", newPassword: "New password (12+ characters)", disableTwoFactor: "Disable 2FA", recoveryCodes: "Recovery codes (shown once)",
  group: "Group", hostFingerprint: "SSH fingerprint (recommended)", uploadPem: "Upload PEM", commandHistorySetting: "Store command history"
};

export type TranslationKey = keyof typeof zh;
export type TFunction = (key: TranslationKey) => string;
export function createT(language: Language): TFunction {
  const dictionary = language === "en" ? en : zh;
  return (key) => dictionary[key] ?? key;
}
