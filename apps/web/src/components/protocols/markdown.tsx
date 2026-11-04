import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";

// The page already has its h1, so a body's headings start one level down. Raw HTML in
// the Markdown shows as text (no rehype-raw), and images render as links: a page
// attaches pictures as linked files, and remote images would tell their host who's reading.
// react-markdown hands each component its syntax tree node, which isn't a DOM attribute.
function withoutNode<P extends { node?: unknown }>(props: P): Omit<P, "node"> {
  const rest = { ...props };
  delete rest.node;
  return rest;
}

const components: Components = {
  h1: (props) => <h2 className="mt-10 mb-3 text-heading-small first:mt-0" {...withoutNode(props)} />,
  h2: (props) => <h3 className="mt-8 mb-3 text-heading-xsmall first:mt-0" {...withoutNode(props)} />,
  h3: (props) => <h4 className="mt-6 mb-2 text-label-large first:mt-0" {...withoutNode(props)} />,
  h4: (props) => <h5 className="mt-6 mb-2 text-label-medium first:mt-0" {...withoutNode(props)} />,
  h5: (props) => <h6 className="mt-6 mb-2 text-label-medium first:mt-0" {...withoutNode(props)} />,
  h6: (props) => <h6 className="mt-6 mb-2 text-label-medium first:mt-0" {...withoutNode(props)} />,
  p: (props) => <p className="my-3 first:mt-0" {...withoutNode(props)} />,
  ol: ({ className, ...props }) => (
    <ol className={cn("my-4 list-decimal space-y-2 pl-6 marker:text-content-tertiary marker:tabular-nums", className)} {...withoutNode(props)} />
  ),
  ul: ({ className, ...props }) => (
    <ul className={cn("my-4 list-disc space-y-2 pl-6 marker:text-content-tertiary", className)} {...withoutNode(props)} />
  ),
  li: ({ className, ...props }) => <li className={cn("pl-1 [&>ol]:my-2 [&>ul]:my-2", className)} {...withoutNode(props)} />,
  a: (props) => (
    <a className="text-content-accent underline underline-offset-2" target="_blank" rel="noreferrer" {...withoutNode(props)} />
  ),
  img: ({ src, alt }) =>
    typeof src === "string" && src !== "" ? (
      <a href={src} className="text-content-accent underline underline-offset-2" target="_blank" rel="noreferrer">
        {alt === undefined || alt === "" ? "Image" : alt}
      </a>
    ) : null,
  blockquote: (props) => (
    <blockquote className="my-4 border-l-2 border-border-raised pl-4 text-content-secondary" {...withoutNode(props)} />
  ),
  hr: () => <hr className="my-8 border-border-opaque" />,
  code: ({ className, ...props }) => (
    <code className={cn("rounded-md bg-background-secondary px-1.5 py-0.5 font-mono text-[0.9em]", className)} {...withoutNode(props)} />
  ),
  pre: (props) => (
    <pre
      className="my-4 overflow-x-auto rounded-control border border-border-opaque bg-background-secondary p-4 font-mono text-paragraph-small [&>code]:bg-transparent [&>code]:p-0"
      {...withoutNode(props)}
    />
  ),
  table: (props) => (
    <div className="my-5 overflow-x-auto rounded-control border border-border-opaque">
      <table
        className="w-full border-collapse text-left text-paragraph-small [&_tbody_tr]:border-t [&_tbody_tr]:border-border-opaque"
        {...withoutNode(props)}
      />
    </div>
  ),
  th: (props) => (
    <th className="border-b border-border-opaque bg-background-secondary px-3 py-2 text-label-small text-content-secondary" {...withoutNode(props)} />
  ),
  td: (props) => <td className="px-3 py-2 align-top" {...withoutNode(props)} />,
  input: (props) => <input className="mr-1.5 align-middle accent-content-primary" {...withoutNode(props)} />,
};

export function Markdown({ body, className }: { body: string; className?: string }) {
  return (
    <div className={cn("text-paragraph-large text-content-primary [overflow-wrap:anywhere]", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  );
}
