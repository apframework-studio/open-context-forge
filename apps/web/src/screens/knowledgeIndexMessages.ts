export function indexIssueEnglish(issue: string) {
  const separator = issue.indexOf("：");
  const type = separator < 0 ? issue : issue.slice(0, separator);
  const text = {
    "无法读取": "Unreadable file",
    "正文超过 2 MiB，仅索引文件信息": "Text exceeds 2 MiB. Indexed file metadata only",
    "来源指纹不匹配": "Source fingerprint mismatch",
    "无效来源记录": "Invalid source record",
    "来源清单无法读取": "Could not read the source manifest",
    "目录越界或符号链接": "Folder outside the vault or symbolic link",
    "索引达到 10000 个文件上限": "Index reached the 10,000-file limit",
    "目录无法读取": "Unreadable folder",
  }[type];
  if (!text) return issue;
  return separator < 0 ? text : `${text} · ${issue.slice(separator + 1)}`;
}
