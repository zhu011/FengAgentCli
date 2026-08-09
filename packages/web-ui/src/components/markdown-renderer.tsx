/**
 * @fengagent/web-ui — Markdown 渲染组件
 *
 * 使用 react-markdown + remark-gfm + rehype-highlight
 * 渲染 Markdown 文本并支持代码高亮。
 */

import { memo, useMemo, type ComponentPropsWithoutRef } from "react";
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

function MarkdownRendererImpl({ text }: MarkdownRendererProps) {
  const components = useMemo<Components>(
    () => ({
      pre: (props: ComponentPropsWithoutRef<"pre">) => (
        <pre className="markdown-pre" {...props} />
      ),
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
