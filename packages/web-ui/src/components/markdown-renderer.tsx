/**
 * @fengagent/web-ui — Markdown 渲染组件
 *
 * 使用 react-markdown + remark-gfm + rehype-highlight
 * 渲染 Markdown 文本并支持代码高亮。
 */

import {
  isValidElement,
  memo,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

interface MarkdownRendererProps {
  text: string;
}

/** 检测文本是否包含 Markdown 语法 */
function hasMarkdownSyntax(text: string): boolean {
  return (
    /(^|\n)#{1,6}\s+/.test(text) ||
    /(^|\n)\s*[-*]\s+/.test(text) ||
    /(^|\n)\s*\d+\.\s+/.test(text) ||
    text.includes("```") ||
    /\*\*[^*]+\*\*/.test(text) ||
    /`[^`]+`/.test(text) ||
    /\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(text)
  );
}

/** 从 React 节点中递归提取纯文本 */
function extractTextFromNode(node: ReactNode): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractTextFromNode).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return extractTextFromNode(props.children);
  }
  return "";
}

/** 复制兜底：非安全上下文（无 navigator.clipboard）时用 execCommand */
function fallbackCopy(text: string): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
}

/** 代码块组件 — 带语言标签 + 复制按钮 */
function CodeBlock({ children, ...preProps }: ComponentPropsWithoutRef<"pre">) {
  const [copied, setCopied] = useState(false);

  // 从子 code 元素的 className 提取语言
  const codeChildProps = isValidElement(children)
    ? (children.props as { className?: string; children?: ReactNode })
    : undefined;
  const codeClassName = codeChildProps?.className ?? "";
  const langMatch = /language-(\w+)/.exec(codeClassName);
  const language = langMatch ? langMatch[1] : "";
  const codeText = extractTextFromNode(codeChildProps?.children);

  const handleCopy = () => {
    try {
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(codeText).catch(() => fallbackCopy(codeText));
      } else {
        fallbackCopy(codeText);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      fallbackCopy(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="markdown-code-block-wrapper">
      <div className="markdown-code-block-header">
        <span className="markdown-code-block-lang">{language}</span>
        <button
          className="markdown-code-block-copy"
          onClick={handleCopy}
          aria-live="polite"
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
      <pre className="markdown-pre" tabIndex={0} {...preProps}>
        {children}
      </pre>
    </div>
  );
}

function MarkdownRendererImpl({ text }: MarkdownRendererProps) {
  const components = useMemo<Components>(
    () => ({
      pre: (props: ComponentPropsWithoutRef<"pre">) => <CodeBlock {...props} />,
      code: (props: ComponentPropsWithoutRef<"code">) => {
        const { className, children, ...rest } = props;
        const isInline = !className?.includes("language-");
        return (
          <code
            className={isInline ? "markdown-code-inline" : className}
            {...rest}
          >
            {children}
          </code>
        );
      },
      table: (props: ComponentPropsWithoutRef<"table">) => (
        <table className="markdown-table" {...props} />
      ),
      a: (props: ComponentPropsWithoutRef<"a">) => (
        <a target="_blank" rel="noopener noreferrer" {...props} />
      ),
    }),
    [],
  );

  if (!hasMarkdownSyntax(text)) {
    return <span className="whitespace-pre-wrap">{text}</span>;
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownRenderer = memo(MarkdownRendererImpl);
