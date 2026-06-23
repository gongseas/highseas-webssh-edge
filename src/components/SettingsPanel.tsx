import { Contrast, KeyRound, Languages, LogOut, Settings, Shield, Sun, X } from "lucide-react";
import QRCode from "qrcode";
import { FormEvent, useEffect, useState } from "react";
import type { AppSettings, Language } from "../../shared/types";
import { api } from "../lib/api";
import type { TFunction } from "../lib/i18n";

type Props = { settings: AppSettings; t: TFunction; onChange: (settings: AppSettings) => void; onLogout: () => void; onSecurityChanged: () => void };
type Dialog = "totp-setup" | "totp-disable" | "password" | null;

export function SettingsPanel({ settings, t, onChange, onLogout, onSecurityChanged }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [qrCode, setQrCode] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState("");

  useEffect(() => { if (setup) QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 220 }).then(setQrCode).catch(() => setError(t("totpSetupFailed"))); }, [setup, t]);
  function closeDialog() { setDialog(null); setSetup(null); setQrCode(""); setCode(""); setPassword(""); setNextPassword(""); setRecoveryCodes([]); setError(""); }
  async function startTotp() { setError(""); try { setSetup(await api.setupTotp()); setDialog("totp-setup"); } catch (e) { setError(e instanceof Error ? e.message : t("totpSetupFailed")); } }
  async function confirmTotp(event: FormEvent) { event.preventDefault(); try { const result = await api.verifyTotp(code); setRecoveryCodes(result.recoveryCodes); onSecurityChanged(); } catch (e) { setError(e instanceof Error ? e.message : t("totpSetupFailed")); } }
  async function confirmDisable(event: FormEvent) { event.preventDefault(); try { await api.disableTotp(password, code); closeDialog(); onSecurityChanged(); } catch (e) { setError(e instanceof Error ? e.message : t("totpDisableFailed")); } }
  async function confirmPassword(event: FormEvent) { event.preventDefault(); try { await api.changePassword(password, nextPassword); onLogout(); } catch (e) { setError(e instanceof Error ? e.message : "修改密码失败"); } }

  return <section className="settings-strip">
    <button className="icon-button" title={t("lightTerminal")} onClick={() => onChange({ ...settings, theme: settings.theme === "light" ? "contrast" : "light" })}>{settings.theme === "light" ? <Sun size={17} /> : <Contrast size={17} />}</button>
    <button className="icon-button" title="Settings" onClick={() => setMenuOpen((value) => !value)}><Settings size={18} /></button>
    {menuOpen ? <div className="settings-menu">
      <label className="menu-line"><Languages size={16} /><select value={settings.language} onChange={(e) => onChange({ ...settings, language: e.target.value as Language })}><option value="zh">中文</option><option value="en">English</option></select></label>
      <label className="menu-line"><input type="checkbox" checked={settings.commandHistoryEnabled} onChange={(e) => onChange({ ...settings, commandHistoryEnabled: e.target.checked })} />{t("commandHistorySetting")}</label>
      <button onClick={() => settings.twoFactorEnabled ? setDialog("totp-disable") : void startTotp()}><Shield size={16} />{settings.twoFactorEnabled ? t("disableTwoFactor") : t("enableTwoFactor")}</button>
      <button onClick={() => setDialog("password")}><KeyRound size={16} />{t("changePassword")}</button>
      <button onClick={onLogout}><LogOut size={16} />{t("logout")}</button>
    </div> : null}
    {dialog ? <div className="modal-backdrop" role="dialog" aria-modal="true"><form className="security-dialog" onSubmit={dialog === "totp-setup" ? confirmTotp : dialog === "totp-disable" ? confirmDisable : confirmPassword}>
      <button className="icon-button dialog-close" type="button" onClick={closeDialog}><X size={17} /></button>
      <h2>{dialog === "totp-setup" ? t("enableTwoFactor") : dialog === "totp-disable" ? t("disableTwoFactor") : t("changePassword")}</h2>
      {dialog === "totp-setup" && setup ? <>{qrCode ? <img className="qr-code" alt="TOTP QR" src={qrCode} /> : null}<label>{t("manualSecret")}<input readOnly value={setup.secret} /></label>
        {recoveryCodes.length ? <div className="recovery-codes"><strong>{t("recoveryCodes")}</strong><code>{recoveryCodes.join("\n")}</code></div> : <label>{t("verificationCode")}<input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" /></label>}</> : null}
      {dialog === "totp-disable" ? <><label>{t("currentPassword")}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label><label>{t("verificationCode")}<input value={code} onChange={(e) => setCode(e.target.value)} /></label></> : null}
      {dialog === "password" ? <><label>{t("currentPassword")}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label><label>{t("newPassword")}<input type="password" value={nextPassword} onChange={(e) => setNextPassword(e.target.value)} /></label></> : null}
      {error ? <p className="form-error">{error}</p> : null}
      {recoveryCodes.length ? <button className="primary-button" type="button" onClick={closeDialog}>{t("save")}</button> : <button className="primary-button" type="submit">{t("confirmEnable")}</button>}
    </form></div> : null}
  </section>;
}
