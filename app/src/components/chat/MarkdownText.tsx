// 把模型输出的 Markdown 渲染成排版（对齐 claude.app / claude cli）。
// 没有这层，模型吐的 # 标题、| 表格 |、**加粗**、- 列表 会原样以符号显示，刷屏。
// 只用于助手正文（text 段）；用户输入、思考/工具折叠块不走这里。

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const components: Components = {
  h1: (p) => <h1 className="text-base font-bold mt-3 mb-1.5 first:mt-0" {...p} />,
  h2: (p) => <h2 className="text-[15px] font-bold mt-3 mb-1.5 first:mt-0" {...p} />,
  h3: (p) => <h3 className="text-sm font-semibold mt-2.5 mb-1 first:mt-0" {...p} />,
  h4: (p) => <h4 className="text-sm font-semibold mt-2 mb-1 first:mt-0" {...p} />,
  p: (p) => <p className="my-1.5 first:mt-0 last:mb-0 leading-relaxed" {...p} />,
  ul: (p) => <ul className="my-1.5 ml-4 list-disc space-y-0.5" {...p} />,
  ol: (p) => <ol className="my-1.5 ml-4 list-decimal space-y-0.5" {...p} />,
  li: (p) => <li className="leading-relaxed" {...p} />,
  strong: (p) => <strong className="font-semibold" {...p} />,
  em: (p) => <em className="font-medium not-italic" {...p} />,
  a: (p) => <a className="text-primary underline underline-offset-2 hover:opacity-80" target="_blank" rel="noreferrer" {...p} />,
  hr: () => <hr className="my-3 border-white/10" />,
  blockquote: (p) => <blockquote className="my-2 pl-3 border-l-2 border-primary/30 text-muted-foreground" {...p} />,
  pre: (p) => <pre className="my-2 p-3 rounded-xl bg-foreground/[0.06] overflow-x-auto text-[12px] leading-relaxed font-mono" {...p} />,
  code: ({ className, children, ...rest }) => {
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) {
      return <code className={cn("font-mono", className)} {...rest}>{children}</code>;
    }
    return (
      <code className="px-1 py-0.5 rounded bg-foreground/[0.08] text-[0.9em] font-mono" {...rest}>
        {children}
      </code>
    );
  },
  // 表格：横向可滚，避免窄屏撑破
  table: (p) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full text-[12px] border-collapse" {...p} />
    </div>
  ),
  thead: (p) => <thead className="border-b border-white/15" {...p} />,
  th: (p) => <th className="text-left font-semibold px-2 py-1.5" {...p} />,
  td: (p) => <td className="px-2 py-1.5 border-t border-white/[0.08] align-top" {...p} />,
};

export function MarkdownText({ content }: { content: string }) {
  return (
    <div className="break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
