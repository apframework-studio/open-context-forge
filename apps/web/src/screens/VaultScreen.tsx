import { useState } from "react";
import { ApiError, api, type Vault, type VaultList } from "../api";

interface Props { vaults: VaultList | null; refresh: () => Promise<void> }

export function VaultScreen({ vaults, refresh }: Props) {
  const [id, setId] = useState("");
  const [path, setPath] = useState("");
  const [plannedChanges, setPlannedChanges] = useState<string[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(adopt: boolean) {
    setBusy(true); setMessage("");
    try {
      await api<Vault>("/vaults", { method: "POST", body: { id, path, adopt } });
      setPlannedChanges(null); setId(""); setPath("");
      setMessage("知识库已添加");
      await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.code === "ADOPTION_REQUIRED") {
        setPlannedChanges(error.plannedChanges ?? []);
      } else setMessage(error instanceof Error ? error.message : "添加失败");
    } finally { setBusy(false); }
  }

  async function makeDefault(vaultId: string) {
    try {
      await api("/vaults/default", { method: "PUT", body: { vaultId } });
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "切换失败"); }
  }

  return <div className="screen-stack">
    <section className="panel-card">
      <div className="section-heading"><div><span className="overline">VAULTS</span><h2>已连接的知识库</h2></div><span className="count-pill">{vaults?.vaults.length ?? 0} 个</span></div>
      <p className="muted">首次启动会自动创建内置库。你也可以连接现有的 Obsidian 目录，并指定默认导入目标。</p>
      <div className="vault-list">
        {vaults?.vaults.map((vault) => <div className="vault-row" key={vault.id}>
          <div className="vault-symbol">{vault.kind === "built-in" ? "◆" : "◇"}</div>
          <div className="vault-meta"><strong>{vault.id}</strong><small>{vault.kind === "built-in" ? "内置知识库" : "外部 Obsidian vault"} · {vault.path}</small></div>
          {vault.isDefault ? <span className="tag success">默认</span> : <button className="text-button" onClick={() => void makeDefault(vault.id)}>设为默认</button>}
        </div>)}
      </div>
    </section>
    <section className="panel-card">
      <div className="section-heading"><div><span className="overline">CONNECT</span><h2>添加外部知识库</h2></div></div>
      <p className="muted">使用现有目录中的笔记；若还没有 OCF 元数据，确认后只会新增来源目录与 .ocf 文件。</p>
      <div className="form-grid two"><label>知识库 ID<input value={id} onChange={(event) => { setId(event.target.value); setPlannedChanges(null); }} placeholder="research" /></label><label>外部 vault 路径<input value={path} onChange={(event) => { setPath(event.target.value); setPlannedChanges(null); }} placeholder="/Users/you/Documents/My Vault" /></label></div>
      {plannedChanges && <div className="notice"><strong>需要确认采用</strong><p>将在所选目录中创建或使用：</p><ul>{plannedChanges.map((change) => <li key={change}>{change}</li>)}</ul><p>现有笔记不会被改写。</p><button className="primary-button" disabled={busy} onClick={() => void add(true)}>确认采用此目录</button></div>}
      <div className="action-row"><button className="primary-button" disabled={busy || !id.trim() || !path.trim()} onClick={() => void add(false)}>添加外部知识库</button>{message && <span className="inline-message">{message}</span>}</div>
    </section>
  </div>;
}
