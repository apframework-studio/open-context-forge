import { useEffect, useState } from "react";
import { api, type ImportBatch, type SourceRef, type VaultList } from "../api";

interface Props { vaults: VaultList | null; onImported: (source: SourceRef) => void }

export function ImportScreen({ vaults, onImported }: Props) {
  const [targetVaultId, setTargetVaultId] = useState("");
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (vaults && !targetVaultId) setTargetVaultId(vaults.defaultVaultId); }, [vaults, targetVaultId]);
  useEffect(() => {
    const batchId = localStorage.getItem("ocf-last-batch");
    if (!batchId) return;
    void api<ImportBatch>(`/imports/${batchId}`).then(setBatch).catch(() => localStorage.removeItem("ocf-last-batch"));
  }, []);

  async function upload(file?: File) {
    if (!file) return;
    setBusy(true); setMessage("");
    try {
      const form = new FormData(); form.append("file", file);
      const result = await api<ImportBatch>("/imports/preflight", { method: "POST", body: form });
      setBatch(result);
      localStorage.setItem("ocf-last-batch", result.batchId);
    } catch (error) { setMessage(error instanceof Error ? error.message : "预检失败"); }
    finally { setBusy(false); }
  }

  async function commit(item: ImportBatch["candidates"][number]) {
    if (!batch || !targetVaultId) return;
    setBusy(true); setMessage("");
    try {
      const result = await api<{ vaultId: string; snapshot: string }>(`/imports/${batch.batchId}/items/${item.id}/commit`, { method: "POST", body: { vaultId: targetVaultId } });
      onImported({ vaultId: result.vaultId, snapshot: result.snapshot });
      setBatch(await api<ImportBatch>(`/imports/${batch.batchId}`));
      setMessage(`已导入 ${result.vaultId}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "导入失败"); }
    finally { setBusy(false); }
  }

  return <div className="screen-stack">
    <section className="panel-card">
      <div className="section-heading"><div><span className="overline">SOURCE INTAKE</span><h2>导入与预检</h2></div><span className="tag">Clipper ZIP</span></div>
      <p className="muted">先检查来源与完整性，再明确选择要写入的知识库。来源快照导入后保持不变。</p>
      <div className="form-grid two"><label>导入 Clipper ZIP<input type="file" accept=".zip,application/zip" onChange={(event) => void upload(event.target.files?.[0])} /></label><label>目标知识库<select value={targetVaultId} onChange={(event) => setTargetVaultId(event.target.value)}>{vaults?.vaults.map((vault) => <option key={vault.id} value={vault.id}>{vault.id}{vault.isDefault ? " · 默认" : ""}</option>)}</select></label></div>
      {message && <p className="inline-message" role="status">{message}</p>}
    </section>
    {batch && <section className="panel-card">
      <div className="section-heading"><div><span className="overline">PREFLIGHT</span><h2>批次预检</h2></div><span className="count-pill">{batch.candidates.length} 篇</span></div>
      <div className="candidate-list">{batch.candidates.map((item) => <article className="candidate" key={item.id}>
        <div><div className="candidate-top"><strong>{item.title}</strong><span className={`tag ${item.status === "ready" ? "success" : item.status === "imported" ? "success" : "warning"}`}>{item.status === "ready" ? "可导入" : item.status === "incomplete" ? "不完整" : item.status === "imported" ? "已导入" : "失败"}</span></div><a href={item.originalUrl} target="_blank" rel="noreferrer">{item.originalUrl}</a><p>{item.markdown.slice(0, 150)}</p>{item.warnings.length > 0 && <small>提示：{item.warnings.join("、")}</small>}</div>
        <button className="secondary-button" disabled={busy || item.status !== "ready" || !targetVaultId} onClick={() => void commit(item)}>确认导入</button>
      </article>)}</div>
    </section>}
  </div>;
}
