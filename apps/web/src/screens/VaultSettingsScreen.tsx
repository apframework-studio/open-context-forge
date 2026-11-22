import { useEffect, useState } from "react";
import { ApiError, api, type BrandingStatus, type ImportPolicy, type KnowledgeOverview, type Vault, type VaultList } from "../api";
import { useLocale, type LocalizedNotice } from "../locale";
import { WorkbenchSelect } from "../WorkbenchSelect";
import { indexIssueEnglish } from "./knowledgeIndexMessages";

interface Props {
  vaults: VaultList | null;
  refresh: () => Promise<void>;
  focusSection?: "capture" | "vaults" | null;
  branding: BrandingStatus;
  iconUrl: string;
  onBrandingChange: (status: BrandingStatus) => void;
}

export function VaultSettingsScreen({ vaults, refresh, focusSection, branding, iconUrl, onBrandingChange }: Props) {
  const { locale, setLocale, t, noticeText } = useLocale();
  const [overview, setOverview] = useState<KnowledgeOverview | null>(null);
  const [id, setId] = useState("");
  const [path, setPath] = useState("");
  const [plannedChanges, setPlannedChanges] = useState<string[] | null>(null);
  const [message, setMessage] = useState<LocalizedNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const [captureMode, setCaptureMode] = useState<ImportPolicy["mode"]>("manual");
  const [captureVaultId, setCaptureVaultId] = useState("");
  const [captureAuthorship, setCaptureAuthorship] = useState<ImportPolicy["defaultAuthorship"]>("unknown");
  const [captureMessage, setCaptureMessage] = useState<LocalizedNotice | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [maintenanceOverrides, setMaintenanceOverrides] = useState<Record<string, boolean>>({});
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [iconMessage, setIconMessage] = useState<LocalizedNotice | null>(null);
  const [iconBusy, setIconBusy] = useState(false);

  useEffect(() => {
    if (!iconFile) { setIconPreview(null); return; }
    const preview = URL.createObjectURL(iconFile);
    setIconPreview(preview);
    return () => URL.revokeObjectURL(preview);
  }, [iconFile]);

  useEffect(() => { void api<KnowledgeOverview>("/knowledge/overview").then(setOverview).catch(() => undefined); }, [vaults]);
  useEffect(() => {
    void api<ImportPolicy>("/imports/policy").then((policy) => {
      setCaptureMode(policy.mode); setCaptureVaultId(policy.vaultId ?? vaults?.defaultVaultId ?? "");
      setCaptureAuthorship(policy.defaultAuthorship);
    }).catch((error) => setCaptureMessage([error, "读取采集规则失败", "Could not load import rules."]));
  }, [vaults]);
  useEffect(() => {
    if (!focusSection) return;
    const frame = requestAnimationFrame(() => document.getElementById(focusSection === "capture" ? "capture-settings" : "vault-connections")?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [focusSection]);

  async function saveCapturePolicy() {
    setCaptureBusy(true); setCaptureMessage(null);
    try {
      await api<ImportPolicy>("/imports/policy", { method: "PUT", body: {
        mode: captureMode, vaultId: captureMode === "auto-file" ? captureVaultId : null,
        defaultAuthorship: captureAuthorship,
      } });
      setCaptureMessage(["采集规则已保存", "Import rules saved."]);
    } catch (error) { setCaptureMessage([error, "保存采集规则失败", "Could not save import rules."]); }
    finally { setCaptureBusy(false); }
  }

  async function saveIcon() {
    if (!iconFile) return;
    setIconBusy(true); setIconMessage(null);
    try {
      const form = new FormData();
      form.append("file", iconFile);
      onBrandingChange(await api<BrandingStatus>("/branding/icon", { method: "PUT", body: form }));
      setIconFile(null); setIconMessage(["图标已更新", "Icon updated."]);
    } catch (error) { setIconMessage([error, "图标更新失败", "Could not update the icon."]); }
    finally { setIconBusy(false); }
  }

  async function restoreIcon() {
    setIconBusy(true); setIconMessage(null);
    try {
      onBrandingChange(await api<BrandingStatus>("/branding/icon", { method: "DELETE" }));
      setIconFile(null); setIconMessage(["已恢复默认图标", "Default icon restored."]);
    } catch (error) { setIconMessage([error, "恢复默认图标失败", "Could not restore the default icon."]); }
    finally { setIconBusy(false); }
  }

  async function add(adopt: boolean) {
    setBusy(true); setMessage(null);
    try {
      await api<Vault>("/vaults", { method: "POST", body: { id, path, adopt } });
      setPlannedChanges(null); setId(""); setPath(""); setMessage(["知识库已连接，原有笔记可在知识库中浏览", "Knowledge base connected. Your existing notes are ready to browse."]);
      await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.code === "ADOPTION_REQUIRED") setPlannedChanges(error.plannedChanges ?? []);
      else setMessage([error, "连接失败", "Could not connect the knowledge base."]);
    } finally { setBusy(false); }
  }

  async function makeDefault(vaultId: string) {
    try { await api("/vaults/default", { method: "PUT", body: { vaultId } }); await refresh(); }
    catch (error) { setMessage([error, "切换失败", "Could not change the default knowledge base."]); }
  }

  async function setAutoMaintain(vaultId: string, enabled: boolean) {
    setMaintenanceOverrides((current) => ({ ...current, [vaultId]: enabled }));
    setBusy(true); setMessage(null);
    try {
      await api(`/vaults/${encodeURIComponent(vaultId)}/maintenance-policy`, { method: "PUT", body: { enabled } });
      await refresh();
      setMessage([`${vaultId} 已${enabled ? "启用" : "关闭"}入库后自动维护`,
        `Automatic maintenance ${enabled ? "enabled" : "disabled"} for ${vaultId}.`]);
    } catch (error) { setMessage([error, "保存自动维护设置失败", "Could not save the maintenance setting."]); }
    finally {
      setMaintenanceOverrides((current) => { const next = { ...current }; delete next[vaultId]; return next; });
      setBusy(false);
    }
  }

  async function rescan(vaultId: string) {
    setBusy(true); setMessage(null);
    try {
      await api(`/knowledge/${encodeURIComponent(vaultId)}/rescan`, { method: "POST" });
      setOverview(await api<KnowledgeOverview>("/knowledge/overview")); setMessage([`${vaultId} 已重新索引`, `Reindexed ${vaultId}.`]);
    } catch (error) { setMessage([error, "索引失败", "Could not reindex the knowledge base."]); }
    finally { setBusy(false); }
  }

  async function disconnect(vaultId: string) {
    if (!window.confirm(t(`断开 ${vaultId}？原目录和笔记不会删除。`, `Disconnect ${vaultId}? Its folder and notes will stay on this device.`))) return;
    setBusy(true); setMessage(null);
    try {
      await api(`/vaults/${encodeURIComponent(vaultId)}`, { method: "DELETE" });
      await refresh(); setMessage([`${vaultId} 已断开，原文件保留`, `Disconnected ${vaultId}. Your files are still in the original folder.`]);
    } catch (error) { setMessage([error, "断开失败", "Could not disconnect the knowledge base."]); }
    finally { setBusy(false); }
  }

  return <div className="screen-stack">
    <section className="panel-card" id="appearance-settings">
      <div className="section-heading"><h2>{t("外观", "Appearance")}</h2></div>
      <div className="locale-setting">
        <span id="locale-setting-label">{t("界面语言", "Language")}</span>
        <div role="group" aria-labelledby="locale-setting-label" className="workspace-theme-switch">
          <button type="button" lang="zh-CN" aria-pressed={locale === "zh-CN"} onClick={() => setLocale("zh-CN")}>中文</button>
          <button type="button" lang="en" aria-pressed={locale === "en"} onClick={() => setLocale("en")}>English</button>
        </div>
      </div>
      <p className="muted">{t("当前名称：文脉引擎。图标用于侧栏和浏览器标签，可随时更换或恢复默认。", "Choose an icon for the Wenmai sidebar and browser tab.")}</p>
      <div className="branding-settings">
        <img className="branding-preview" src={iconPreview ?? iconUrl} alt={t("当前图标预览", "Current icon preview")} />
        <div className="branding-settings-main">
          <label htmlFor="branding-icon-file">{t("替换图标", "Replace icon")}</label>
          <input id="branding-icon-file" type="file" accept="image/png,.png" disabled={iconBusy}
            onChange={(event) => { setIconFile(event.currentTarget.files?.[0] ?? null); event.currentTarget.value = ""; setIconMessage(null); }} />
          <small>{t("选择 32–512 像素的正方形 PNG，文件不超过 1 MiB。", "Choose a square PNG from 32 to 512 pixels, up to 1 MiB.")}</small>
          <div className="action-row">
            <button className="primary-button" disabled={!iconFile || iconBusy} onClick={() => void saveIcon()}>{t("保存图标", "Save icon")}</button>
            {branding.customized && <button className="secondary-button" disabled={iconBusy} onClick={() => void restoreIcon()}>{t("恢复默认", "Restore default")}</button>}
            {iconMessage && <span className="inline-message" role="status">{noticeText(iconMessage)}</span>}
          </div>
        </div>
      </div>
    </section>
    <section className="panel-card" id="capture-settings">
      <div className="section-heading"><h2>{t("资料导入规则", "Import rules")}</h2></div>
      <div className="form-grid two"><div className="select-field"><span>{t("采集后如何处理", "After import")}</span>
        <WorkbenchSelect label={t("采集后如何处理", "After import")} value={captureMode} onChange={(value) => setCaptureMode(value as ImportPolicy["mode"])}
          options={[{ value: "manual", label: t("先放待整理", "Review before filing") }, { value: "auto-file", label: t("自动直接入库", "File automatically") }]} /></div>
        {captureMode === "auto-file" && <div className="select-field"><span>{t("自动入库目标", "File to")}</span>
          <WorkbenchSelect label={t("自动入库目标", "File to")} value={captureVaultId} onChange={setCaptureVaultId}
            options={vaults?.vaults.map((vault) => ({ value: vault.id, label: vault.id })) ?? []} /></div>}
        <div className="select-field"><span>{t("原文默认归属", "Default attribution")}</span><WorkbenchSelect label={t("原文默认归属", "Default attribution")} value={captureAuthorship}
          onChange={(value) => setCaptureAuthorship(value as ImportPolicy["defaultAuthorship"])}
          options={[{ value: "unknown", label: t("待确认", "Unconfirmed") }, { value: "self", label: t("本人原创", "My own work") },
            { value: "third_party", label: t("第三方文章", "Third-party work") }]} /></div></div>
      <div className="action-row"><button className="primary-button" disabled={captureBusy || (captureMode === "auto-file" && !captureVaultId)}
        onClick={() => void saveCapturePolicy()}>{t("保存采集设置", "Save import rules")}</button>{captureMessage && <span className="inline-message" role="status">{noticeText(captureMessage)}</span>}</div>
    </section>
    <section className="panel-card" id="vault-connections">
      <div className="section-heading"><h2>{t("知识库连接", "Knowledge base connections")}</h2><span className="count-pill">{t(`${vaults?.vaults.length ?? 0} 个`, String(vaults?.vaults.length ?? 0))}</span></div>
      <p className="muted">{t("内置库首次运行自动建立；外部库连接本机原目录。笔记在 Obsidian 编辑，网页负责浏览和索引。", "Wenmai creates a built-in knowledge base on first launch. You can also connect an existing local vault. Edit notes in Obsidian and browse or index them in Wenmai.")}</p>
      <div className="vault-list">{vaults?.vaults.map((vault) => {
        const stats = overview?.vaults.find((item) => item.id === vault.id);
        return <div className="vault-row knowledge-connection" key={vault.id}>
          <div className="vault-symbol">{vault.kind === "built-in" ? "◆" : "◇"}</div>
          <div className="vault-meta"><strong>{vault.id} {vault.isDefault && <span className="tag success">{t("默认入库", "Default")}</span>}</strong>
            <small>{vault.kind === "built-in" ? t("内置知识库", "Built-in knowledge base") : t("外部 Obsidian vault", "External Obsidian vault")} · {vault.path}</small>
            <small>{stats ? t(`${stats.sources} 篇来源 · ${stats.notes} 篇笔记 · 库内分析文件 ${stats.confirmedAnalyses} · ${new Date(stats.indexedAt).toLocaleString(locale)}`,
              `Sources: ${stats.sources}, notes: ${stats.notes}, analyses: ${stats.confirmedAnalyses}. Indexed ${new Date(stats.indexedAt).toLocaleString(locale)}`) : t("等待索引", "Waiting to index")}</small>
            {stats && <small>{stats.readable ? t("可读取", "Readable") : t("无法读取", "Unreadable")} · {stats.writable ? t("可写入来源", "Can file sources") : t("无法写入来源", "Cannot file sources")} · {stats.watching ? t("监听文件变化", "Watching for changes") : t("读取时检查变化", "Checks for changes when opened")}</small>}
            {!!stats?.errors.length && <small className="inline-message error">{t(`${stats.errors.length} 项读取异常：`, `Read errors: ${stats.errors.length}. `)}{locale === "en" ? indexIssueEnglish(stats.errors[0]) : stats.errors[0]}</small>}</div>
          <div className="knowledge-connection-actions">
            <label><input type="checkbox" aria-label={t(`${vault.id} 入库后自动维护`, `Maintain ${vault.id} automatically after filing`)} checked={maintenanceOverrides[vault.id] ?? vault.autoMaintain}
              disabled={busy} onChange={(event) => void setAutoMaintain(vault.id, event.currentTarget.checked)} />{t("入库后自动维护", "Maintain automatically after filing")}</label>
            {!vault.isDefault && <button className="text-button" disabled={busy} onClick={() => void makeDefault(vault.id)}>{t("设为默认", "Make default")}</button>}
            <button className="text-button" disabled={busy} onClick={() => void rescan(vault.id)}>{t("重新索引", "Reindex")}</button>
            {vault.kind === "external" && <button className="text-button" disabled={busy} onClick={() => void disconnect(vault.id)}>{t("断开连接", "Disconnect")}</button>}
          </div>
        </div>;
      })}</div>
      <p className="muted">{t("开启后，逐篇分析新入库资料。适合整理且校验通过的内容会写入知识笔记。", "Analyzes newly filed sources one at a time and writes validated findings to knowledge notes.")}</p>
      <details className="muted"><summary>{t("查看自动维护规则", "Automatic maintenance rules")}</summary>
        <p>{t("单个 Claude CLI 逐篇处理。分析结论为 compile_now 且校验通过时直接写入知识笔记。", "A single Claude CLI process runs each task in order. A validated compile_now result is written directly to knowledge notes.")}</p>
      </details>
    </section>
    <section className="panel-card">
      <div className="section-heading"><h2>{t("连接已有知识库", "Connect a knowledge base")}</h2></div>
      <p className="muted">{t("填写本机 Obsidian 知识库的文件夹路径。首次连接时可预览将新增的文件。", "Enter the folder path of an Obsidian vault on this device. You can preview any files Wenmai will add.")}</p>
      <div className="form-grid two"><label>{t("知识库 ID", "Knowledge base ID")}<input value={id} onChange={(event) => { setId(event.target.value); setPlannedChanges(null); }} placeholder="research" /></label>
        <label>{t("外部 vault 路径", "Vault folder path")}<input value={path} onChange={(event) => { setPath(event.target.value); setPlannedChanges(null); }} placeholder="/Users/you/Documents/My Vault" /></label></div>
      {plannedChanges && <div className="notice"><strong>{t("采用前预览", "Preview changes")}</strong><p>{t("将在所选目录中新建：", "Files to be created in the selected folder")}</p><ul>{plannedChanges.map((change) => <li key={change}>{change}</li>)}</ul>
        <p>{t("现有笔记不改写。", "Existing notes are kept as they are.")}</p><button className="primary-button" disabled={busy} onClick={() => void add(true)}>{t("确认连接此目录", "Confirm connection")}</button></div>}
      <div className="action-row"><button className="primary-button" disabled={busy || !id.trim() || !path.trim()} onClick={() => void add(false)}>{t("连接知识库", "Connect")}</button>
        {message && <span className="inline-message" role="status">{noticeText(message)}</span>}</div>
    </section>
  </div>;
}
