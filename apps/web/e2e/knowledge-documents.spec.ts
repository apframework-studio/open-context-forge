import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

function previewPdf() {
  const text = "BT /F1 18 Tf 30 140 Td (Knowledge document preview) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  return pdf + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test("nested MDX and PDF documents appear with recursive counts and safe previews", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "ocf-document-browser-"));
  const id = `document-browser-${Date.now().toString(36)}`;
  for (const folder of ["10-raw/public-blog/essay", "10-raw/public-blog/notes", "10-raw/public-blog/opensource",
    "10-raw/public-blog/assets", "10-raw/web-clips", "10-raw/_legacy-public-blog", "20-wiki", "Empty"]) mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, "10-raw/public-blog/essay/Essay.mdx"), "# MDX article\n\nMDX evidence is readable.\n\n<script>window.UNSAFE_MDX = true</script>\n");
  writeFileSync(join(root, "10-raw/public-blog/notes/Note.md"), "# Markdown note\n\nReadable note.\n");
  writeFileSync(join(root, "10-raw/public-blog/opensource/Report.pdf"), previewPdf());
  writeFileSync(join(root, "10-raw/web-clips/Clip.md"), "# Web clip\n\nEvidence.\n");
  writeFileSync(join(root, "10-raw/public-blog/assets/diagram.png"), "image bytes");
  writeFileSync(join(root, "10-raw/_legacy-public-blog/Old.md"), "# Backup\n");
  const headers = { "x-ocf-client": "1" };
  try {
    expect((await page.request.post("/api/v1/vaults", { headers, data: { id, path: root, adopt: true } })).status()).toBe(201);
    const profilePath = join(root, ".ocf/vault.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    profile.paths.wiki = "20-wiki"; profile.paths.sources = "10-raw/public-blog";
    writeFileSync(profilePath, JSON.stringify(profile));
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/");
    await page.getByRole("button", { name: "知识库", exact: true }).click();
    await page.getByRole("combobox", { name: "选择知识库" }).click();
    await page.getByRole("option", { name: id, exact: true }).click();
    await page.getByRole("tab", { name: "浏览", exact: true }).click();
    const folders = page.getByLabel("知识库目录", { exact: true });
    const folder = (path: string) => folders.getByRole("button", { name: `${id} / ${path}`, exact: true });
    await expect(folder("10-raw/public-blog")).toContainText("3");
    await expect(folder("10-raw/public-blog/essay")).toContainText("1");
    await expect(folder("10-raw/public-blog/notes")).toContainText("1");
    await expect(folder("10-raw/public-blog/opensource")).toContainText("1");
    await expect(folder("10-raw/public-blog/assets")).toBeHidden();
    await expect(folder("Empty")).toBeHidden();
    await expect(folder("20-wiki")).toBeHidden();
    await expect(folders).not.toContainText("_legacy-public-blog");
    await expect(page.locator(".knowledge-item")).toHaveCount(4);
    await folder("10-raw/public-blog").click();
    await expect(page.locator(".knowledge-item")).toHaveCount(3);
    await page.locator(".knowledge-item").filter({ hasText: "MDX article" }).click();
    await expect(page.getByLabel("内容详情", { exact: true })).toContainText("MDX evidence is readable.");
    expect(await page.evaluate(() => (window as Window & { UNSAFE_MDX?: boolean }).UNSAFE_MDX)).toBeUndefined();
    await page.locator(".knowledge-item").filter({ hasText: "Report" }).click();
    const viewer = page.getByTitle("PDF 预览：Report", { exact: true });
    await expect(viewer).toBeVisible();
    await expect(viewer).toHaveAttribute("src", `/api/v1/knowledge/files/${id}?path=10-raw%2Fpublic-blog%2Fopensource%2FReport.pdf`);
    await expect(page.getByRole("button", { name: "查看 Markdown", exact: true })).toBeHidden();
    const response = await page.request.get((await viewer.getAttribute("src"))!);
    expect(response.headers()["content-type"]).toBe("application/pdf");
    await page.screenshot({ path: "/private/tmp/ocf-knowledge-document-browser.png" });
    await page.getByRole("button", { name: "文章工作台", exact: true }).click();
    await page.getByRole("button", { name: "新建文章", exact: true }).click();
    await page.getByRole("button", { name: "选择创作资料", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "选择创作资料" });
    await drawer.getByLabel(`选择知识库 ${id}`, { exact: true }).check();
    await expect(drawer.getByLabel("选用 Report", { exact: true })).toBeDisabled();
    await drawer.getByLabel("选用 MDX article", { exact: true }).check();
    await drawer.getByRole("button", { name: "带入对话（1）", exact: true }).click();
    await expect(page.getByLabel("本轮引用资料")).toContainText("MDX article");
  } finally {
    await page.request.delete(`/api/v1/vaults/${id}`, { headers });
    rmSync(root, { recursive: true, force: true });
  }
});
