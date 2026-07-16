// Markdown rendering for assistant chat messages (ask answers, design-partner
// replies come back as markdown — headers, lists, code, tables).
//
// react-markdown with remark-gfm: raw HTML is NOT rendered (react-markdown
// skips it by default — that's the XSS posture we want; the app CSP is the
// backstop). Styling is a component map on existing Tailwind tokens, so no
// typography plugin is needed and the bubbles inherit the chat's look.
//
// MOBILE_FIRST: code blocks and tables scroll inside their own container —
// never the page; everything else wraps.

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components = {
  h1: ({ children }) => <p className="font-semibold text-base mt-2 first:mt-0 mb-1">{children}</p>,
  h2: ({ children }) => <p className="font-semibold text-sm mt-2 first:mt-0 mb-1">{children}</p>,
  h3: ({ children }) => <p className="font-semibold text-sm mt-2 first:mt-0 mb-0.5">{children}</p>,
  h4: ({ children }) => <p className="font-medium text-sm mt-1.5 first:mt-0">{children}</p>,
  h5: ({ children }) => <p className="font-medium text-sm mt-1.5 first:mt-0">{children}</p>,
  h6: ({ children }) => <p className="font-medium text-sm mt-1.5 first:mt-0">{children}</p>,
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-1 ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 ml-4 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="break-words">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:opacity-80 break-all">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-2 border-border" />,
  // Inline code vs fenced block: react-markdown wraps fenced code in <pre>,
  // so the bare <code> renderer only needs the inline look.
  code: ({ children }) => (
    <code className="rounded bg-black/20 px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-1.5 overflow-x-auto rounded-md bg-black/25 p-2.5 font-mono text-xs leading-relaxed [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="text-xs border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-medium bg-black/10">{children}</th>,
  td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
};

export default function Markdown({ children }) {
  return (
    <div className="text-sm break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {String(children ?? '')}
      </ReactMarkdown>
    </div>
  );
}
