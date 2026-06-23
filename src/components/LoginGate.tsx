import { LockKeyhole, ShieldCheck, UserPlus } from "lucide-react";
import { FormEvent, useState } from "react";
import type { Language } from "../../shared/types";
import { api, ApiError } from "../lib/api";
import type { TFunction } from "../lib/i18n";

type Props = {
  needsSetup: boolean;
  language: Language;
  t: TFunction;
  onLanguageChange: (language: Language) => void;
  onAuthenticated: () => void;
};

export function LoginGate({ needsSetup, language, t, onLanguageChange, onAuthenticated }: Props) {
  const [username, setUsername] = useState(needsSetup ? "admin" : "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [needsOtp, setNeedsOtp] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (needsSetup && password !== confirmPassword) {
      setError(language === "zh" ? "两次输入的密码不一致" : "Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      if (needsSetup) await api.setup(username, password);
      else await api.login(username, password, otp || undefined);
      onAuthenticated();
    } catch (err) {
      if (err instanceof ApiError && err.code === "TOTP_REQUIRED") setNeedsOtp(true);
      setError(err instanceof Error ? err.message : t("loginFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-mark"><LockKeyhole size={24} /></span>
          <div><h1>{t("appName")}</h1><p>{needsSetup ? t("setupTitle") : t("productName")}</p></div>
        </div>
        <select className="language-select" value={language} onChange={(event) => onLanguageChange(event.target.value as Language)}>
          <option value="zh">{t("languageZh")}</option><option value="en">{t("languageEn")}</option>
        </select>
        <label>{t("username")}<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus /></label>
        <label>{t("managementPassword")}<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete={needsSetup ? "new-password" : "current-password"} /></label>
        {needsSetup ? <label>{language === "zh" ? "确认密码" : "Confirm password"}<input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" autoComplete="new-password" /></label> : null}
        {needsOtp ? <label>{t("twoFactorCode")}<input value={otp} onChange={(event) => setOtp(event.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus /></label> : null}
        {error ? <p className="form-error">{error}</p> : null}
        <button className="primary-button" type="submit" disabled={busy}>
          {needsSetup ? <UserPlus size={18} /> : <ShieldCheck size={18} />}{busy ? "..." : needsSetup ? t("setupTitle") : t("enterConsole")}
        </button>
      </form>
    </main>
  );
}
