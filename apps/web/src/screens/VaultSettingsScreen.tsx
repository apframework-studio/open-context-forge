import { useEffect, useState } from "react";
import { ApiError, api, type BrandingStatus, type ImportPolicy, type KnowledgeOverview, type Vault, type VaultList } from "../api";

interface Props {
  vaults: VaultList | null;
  refresh: () => Promise<void>;
  focusSection?: "capture" | "vaults" | null;
  branding: BrandingStatus;
  iconUrl: string;
  onBrandingChange: (status: BrandingStatus) => void;
}

export function VaultSettingsScreen({ vaults, refresh, focusSection, branding, iconUrl, onBrandingChange }: Props) {
  const [overview, setOverview] = useState<KnowledgeOverview | null>(null);
  const [id, setId] = useState("");
  const [path, setPath] = useState("");
  const [plannedChanges, setPlannedChanges] = useState<string[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [captureMode, setCaptureMode] = useState<ImportPolicy["mode"]>("manual");
  const [captureVaultId, setCaptureVaultId] = useState("");
  const [captureMessage, setCaptureMessage] = useState("");
  const [captureBusy, setCaptureBusy] = useState(false);
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [iconMessage, setIconMessage] = useState("");
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
    }).catch((error) => setCaptureMessage(error instanceof Error ? error.message : "读取采集规则失败"));
  }, [vaults]);
  useEffect(() => {
    if (!focusSection) return;
    const frame = requestAnimationFrame(() => document.getElementById(focusSection === "capture" ? "capture-settings" : "vault-connections")?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [focusSection]);

  async function saveCapturePolicy() {
    setCaptureBusy(true); setCaptureMessage("");
    try {
      await api<ImportPolicy>("/imports/policy", { method: "PUT", body: {
        mode: captureMode, vaultId: captureMode === "auto-file" ? captureVaultId : null,
      } });
      setCaptureMessage("采集规则已保存");
    } catch (error) { setCaptureMessage(error instanceof Error ? error.message : "保存采集规则失败"); }
    finally { setCaptureBusy(false); }
  }

  async function saveIcon() {
    if (!iconFile) return;
    setIconBusy(true); setIconMessage("");
    try {
      const form = new FormData();
      form.append("file", iconFile);
      onBrandingChange(await api<BrandingStatus>("/branding/icon", { method: "PUT", body: form }));
      setIconFile(null); setIconMessage("图标已更新");
    } catch (error) { setIconMessage(error instanceof Error ? error.message : "图标更新失败"); }
    finally { setIconBusy(false); }
  }

  async function restoreIcon() {
    setIconBusy(true); setIconMessage("");
    try {
      onBrandingChange(await api<BrandingStatus>("/branding/icon", { method: "DELETE" }));
      setIconFile(null); setIconMessage("已恢复默认图标");
    } catch (error) { setIconMessage(error instanceof Error ? error.message : "恢复默认图标失败"); }
    finally { setIconBusy(false); }
  }

  async function add(adopt: boolean) {
    setBusy(true); setMessage("");
    try {
      await api<Vault>("/vaults", { method: "POST", body: { id, path, adopt } });
      setPlannedChanges(null); setId(""); setPath(""); setMessage("知识库已连接，原有笔记可在知识库中浏览");
      await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.code === "ADOPTION_REQUIRED") setPlannedChanges(error.plannedChanges ?? []);
      else setMessage(error instanceof Error ? error.message : "连接失败");
    } finally { setBusy(false); }
  }

  async function makeDefault(vaultId: string) {
    try { await api("/vaults/default", { method: "PUT", body: { vaultId } }); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "切换失败"); }
  }

  async function rescan(vaultId: string) {
    setBusy(true); setMessage("");
    try {
      await api(`/knowledge/${encodeURIComponent(vaultId)}/rescan`, { method: "POST" });
      setOverview(await api<KnowledgeOverview>("/knowledge/overview")); setMessage(`${vaultId} 已重新索引`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "索引失败"); }
    finally { setBusy(false); }
  }

  async function disconnect(vaultId: string) {
    if (!window.confirm(`断开 ${vaultId}？原目录和笔记不会删除。`)) return;
    setBusy(true); setMessage("");
    try {
      await api(`/vaults/${encodeURIComponent(vaultId)}`, { method: "DELETE" });
      await refresh(); setMessage(`${vaultId} 已断开，原文件保留`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "断开失败"); }
    finally { setBusy(false); }
  }

  return <div className="screen-stack">
    <section className="panel-card" id="appearance-settings">
      <div className="section-heading"><div><span className="overline">APPEARANCE</span><h2>外观</h2></div></div>
      <p className="muted">当前名称：文脉引擎。图标用于侧栏和浏览器标签，可随时更换或恢复默认。</p>
      <div className="branding-settings">
        <img className="branding-preview" src={iconPreview ?? iconUrl} alt="当前图标预览" />
        <div className="branding-settings-main">
          <label htmlFor="branding-icon-file">替换图标</label>
          <input id="branding-icon-file" type="file" accept="image/png,.png" disabled={iconBusy}
            onChange={(event) => { setIconFile(event.currentTarget.files?.[0] ?? null); event.currentTarget.value = ""; setIconMessage(""); }} />
          <small>选择 32–512 像素的正方形 PNG，文件不超过 1 MiB。</small>
          <div className="action-row">
            <button className="primary-button" disabled={!iconFile || iconBusy} onClick={() => void saveIcon()}>保存图标</button>
            {branding.customized && <button className="secondary-button" disabled={iconBusy} onClick={() => void restoreIcon()}>恢复默认</button>}
            {iconMessage && <span className="inline-message" role="status">{iconMessage}</span>}
          </div>
        </div>
      </div>
    </section>
    <section className="panel-card" id="capture-settings">
      <div className="section-heading"><div><span className="overline">BROWSER CAPTURE</span><h2>浏览器一键采集</h2></div><span className="tag">插件待接入</span></div>
      <p className="muted">浏览器插件尚未接入。当前可在资料处理台导入 Clipper ZIP；这里配置采集后的统一处理规则，插件接入后继续使用。</p>
      <div className="form-grid two"><label>采集后如何处理<select value={captureMode} onChange={(event) => setCaptureMode(event.target.value as ImportPolicy["mode"])}>
        <option value="manual">先放待整理</option><option value="auto-file">自动直接入库</option></select></label>
        {captureMode === "auto-file" && <label>自动入库目标<select value={captureVaultId} onChange={(event) => setCaptureVaultId(event.target.value)}>
          {vaults?.vaults.map((vault) => <option key={vault.id} value={vault.id}>{vault.id}</option>)}</select></label>}</div>
      <div className="action-row"><button className="primary-button" disabled={captureBusy || (captureMode === "auto-file" && !captureVaultId)}
        onClick={() => void saveCapturePolicy()}>保存采集设置</button>{captureMessage && <span className="inline-message" role="status">{captureMessage}</span>}</div>
    </section>
    <section className="panel-card" id="vault-connections">
      <div className="section-heading"><div><span className="overline">CONNECTIONS</span><h2>知识库连接</h2></div><span className="count-pill">{vaults?.vaults.length ?? 0} 个</span></div>
      <p className="muted">内置库首次运行自动建立；外部库连接本机原目录。笔记在 Obsidian 编辑，网页负责浏览和索引。</p>
      <div className="vault-list">{vaults?.vaults.map((vault) => {
        const stats = overview?.vaults.find((item) => item.id === vault.id);
        return <div className="vault-row knowledge-connection" key={vault.id}>
          <div className="vault-symbol">{vault.kind === "built-in" ? "◆" : "◇"}</div>
          <div className="vault-meta"><strong>{vault.id} {vault.isDefault && <span className="tag success">默认入库</span>}</strong>
            <small>{vault.kind === "built-in" ? "内置知识库" : "外部 Obsidian vault"} · {vault.path}</small>
            <small>{stats ? `${stats.sources} 篇来源 · ${stats.notes} 篇笔记 · 库内分析文件 ${stats.confirmedAnalyses} · ${new Date(stats.indexedAt).toLocaleString("zh-CN")}` : "等待索引"}</small>
            {stats && <small>{stats.readable ? "可读取" : "无法读取"} · {stats.writable ? "可写入来源" : "无法写入来源"} · {stats.watching ? "监听文件变化" : "读取时检查变化"}</small>}
            {!!stats?.errors.length && <small className="inline-message error">{stats.errors.length} 项读取异常：{stats.errors[0]}</small>}</div>
          <div className="knowledge-connection-actions">
            {!vault.isDefault && <button className="text-button" disabled={busy} onClick={() => void makeDefault(vault.id)}>设为默认</button>}
            <button className="text-button" disabled={busy} onClick={() => void rescan(vault.id)}>重新索引</button>
            {vault.kind === "external" && <button className="text-button" disabled={busy} onClick={() => void disconnect(vault.id)}>断开连接</button>}
          </div>
        </div>;
      })}</div>
    </section>
    <section className="panel-card">
      <div className="section-heading"><div><span className="overline">CONNECT</span><h2>连接已有知识库</h2></div></div>
      <p className="muted">填写本机 Obsidian vault 目录。没有 OCF 元数据时会先预览新增的文件；原有笔记不会改写或复制。</p>
      <div className="form-grid two"><label>知识库 ID<input value={id} onChange={(event) => { setId(event.target.value); setPlannedChanges(null); }} placeholder="research" /></label>
        <label>外部 vault 路径<input value={path} onChange={(event) => { setPath(event.target.value); setPlannedChanges(null); }} placeholder="/Users/you/Documents/My Vault" /></label></div>
      {plannedChanges && <div className="notice"><strong>采用前预览</strong><p>将在所选目录中新建：</p><ul>{plannedChanges.map((change) => <li key={change}>{change}</li>)}</ul>
        <p>现有笔记不改写。</p><button className="primary-button" disabled={busy} onClick={() => void add(true)}>确认连接此目录</button></div>}
      <div className="action-row"><button className="primary-button" disabled={busy || !id.trim() || !path.trim()} onClick={() => void add(false)}>连接知识库</button>
        {message && <span className="inline-message" role="status">{message}</span>}</div>
    </section>
  </div>;
}
