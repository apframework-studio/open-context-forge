type IconName = "sources" | "vault" | "article" | "publish" | "settings" | "sidebar" | "assistant" | "chevronLeft" | "chevronRight";

const paths: Record<IconName, string> = {
  sources: "M5 3.5h11l3 3V20.5H5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Zm10 0v4h4M7.5 11h9M7.5 15h9",
  vault: "M12 3c-4.5 0-8 1.3-8 3s3.5 3 8 3 8-1.3 8-3-3.5-3-8-3ZM4 6v6c0 1.7 3.5 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.5 3 8 3s8-1.3 8-3v-6",
  article: "M5 3.5h14v17H5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2ZM8 8h8M8 12h8M8 16h5",
  publish: "M12 16V3m0 0L7.5 7.5M12 3l4.5 4.5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5",
  settings: "M10 3h4l.6 2.6c.6.2 1.1.5 1.6.9l2.5-.8 2 3.4-1.9 1.8a7 7 0 0 1 0 2.2l1.9 1.8-2 3.4-2.5-.8c-.5.4-1 .7-1.6.9L14 21h-4l-.6-2.6c-.6-.2-1.1-.5-1.6-.9l-2.5.8-2-3.4 1.9-1.8a7 7 0 0 1 0-2.2L3.3 9.1l2-3.4 2.5.8c.5-.4 1-.7 1.6-.9L10 3ZM12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z",
  sidebar: "M4 4h16v16H4zM9 4v16",
  assistant: "M12 2.5 14 9l6.5 2-6.5 2-2 6.5L10 13l-6.5-2L10 9l2-6.5ZM19 17l.7 2.3L22 20l-2.3.7L19 23l-.7-2.3L16 20l2.3-.7L19 17Z",
  chevronLeft: "m15 18-6-6 6-6",
  chevronRight: "m9 18 6-6-6-6",
};

export function WorkspaceIcon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={paths[name]} />
  </svg>;
}
