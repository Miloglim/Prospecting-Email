import { useRef, useEffect } from "react";
import type { CSSProperties, ClipboardEvent } from "react";

/** contenteditable 富文本编辑器 — 粘贴保留 HTML 格式，图片转 base64 data URL。
 *  兼容 antd Form.Item：接收 value/onChange 作为受控组件。 */
export function RichTextEditor({ value, onChange, placeholder, style, className }: {
  value?: string;
  onChange?: (html: string) => void;
  placeholder?: string;
  style?: CSSProperties;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // 外部 value 变化 → 同步（非聚焦时，避免打断输入）
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el) {
      const next = value || "";
      if (el.innerHTML !== next) el.innerHTML = next;
    }
  }, [value]);

  const emit = () => {
    const el = ref.current;
    if (!el || !onChange) return;
    const html = el.innerHTML || "";
    // 空内容归一为 ""，避免 "<br>" 被判为有值
    onChange(el.textContent?.trim() ? html : "");
  };

  // 图片粘贴 → base64 data URL（否则剪贴板图片以 blob/file 引用插入，保存后失效）
  const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const el = ref.current;
          if (el) el.focus();
          document.execCommand("insertHTML", false, `<img src="${reader.result}" style="max-width:100%;" />`);
          emit();
        };
        reader.readAsDataURL(file);
      }
    }
  };

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      className={`rich-editor ${className || ""}`}
      style={{ minHeight: 60, ...style }}
      onInput={emit}
      onBlur={emit}
      onPaste={handlePaste}
      data-placeholder={placeholder || ""}
    />
  );
}

/** 渲染 HTML 或纯文本（模板/签名预览用） */
export function HtmlText({ html, className }: { html: string; className?: string }) {
  const isHtml = /<[a-z][\s\S]*>/i.test(html || "");
  if (isHtml) {
    return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <div className={`${className || ""} whitespace-pre-wrap`}>{html}</div>;
}
