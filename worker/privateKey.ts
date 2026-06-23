import sshpk from "sshpk";

export function normalizePrivateKeyForSsh(privateKey: string, passphrase?: string) {
  const ppkHeader = privateKey.match(/^PuTTY-User-Key-File-(\d+):/m);
  if (!ppkHeader) return privateKey;

  const version = Number(ppkHeader[1]);
  const encryption = privateKey.match(/^Encryption:\s*(\S+)/mi)?.[1]?.toLowerCase() ?? "none";
  if (version >= 3 && encryption !== "none") {
    throw new Error("暂不支持加密的 PPK v3 私钥，请在 PuTTYgen 中导出为 PPK v2 或 OpenSSH 格式后再上传");
  }

  try {
    const parsed = sshpk.parsePrivateKey(privateKey, "putty" as never, { passphrase, filename: "uploaded.ppk" });
    return parsed.toString("openssh");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`PPK 私钥解析失败：${message}`);
  }
}
