import type { ReactNode } from "react";
import { AppShell, Container } from "@/components/layout/AppShell";
import { getViewer } from "@/lib/auth/viewer";
import { Card } from "@/components/ui";
import guide from "@/lib/guide/content.json";
import { inlineRuns, type Guide, type GuideBlock } from "@/lib/guide/types";

export const metadata = { title: "How to use the album", robots: { index: false, follow: false } };

const G = guide as Guide;

/** `**bold**` for the words somebody presses, `_italic_` for something they might type. Nothing else. */
function Rich({ text }: { text: string }): ReactNode {
  return inlineRuns(text).map((run, i) =>
    run.bold ? <strong key={i} className="font-semibold">{run.text}</strong> : run.italic ? <em key={i}>{run.text}</em> : <span key={i}>{run.text}</span>,
  );
}

function Block({ block }: { block: GuideBlock }) {
  switch (block.kind) {
    case "p":
      return <p className="leading-relaxed"><Rich text={block.text} /></p>;
    case "h3":
      return <h3 className="font-display text-lg font-semibold mt-6">{block.text}</h3>;
    case "small":
      return <p className="text-sm text-muted"><Rich text={block.text} /></p>;
    case "note":
      return (
        <p className="rounded-theme border border-border bg-surface-alt px-4 py-3 leading-relaxed">
          <Rich text={block.text} />
        </p>
      );
    case "bullets":
      return (
        <ul className="list-disc pl-6 space-y-1.5 leading-relaxed">
          {block.items.map((item, i) => <li key={i}><Rich text={item} /></li>)}
        </ul>
      );
    case "steps":
      return (
        <ol className="list-decimal pl-6 space-y-1.5 leading-relaxed">
          {block.items.map((item, i) => <li key={i}><Rich text={item} /></li>)}
        </ol>
      );
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr>
                {block.columns.map((c) => (
                  <th key={c} className="border-b border-border py-2 pr-4 font-semibold align-top">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} className="align-top">
                  {row.map((cell, j) => (
                    <td key={j} className="border-b border-border py-2 pr-4 leading-relaxed">
                      <Rich text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/**
 * The family's guide to the album, as a page.
 *
 * A page first and a PDF second: the family reads this on the phone in their hand, where a PDF is a download that
 * opens in something else and cannot be searched or followed by a link. The PDF is still there, and still the
 * thing to print and leave by the kettle, but it is the copy, not the original.
 *
 * Open to anyone who reaches the site, signed in or not — the first section is how to sign in, and the person who
 * needs it is by definition not signed in.
 */
export default async function GuidePage() {
  const viewer = await getViewer();
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10">
        <div className="max-w-3xl space-y-10">
          <header className="space-y-3">
            <h1 className="font-display text-3xl sm:text-4xl font-semibold">{G.title}</h1>
            <p className="text-lg text-muted">{G.subtitle}</p>
            <div className="space-y-4 pt-2">
              {G.intro.map((block, i) => <Block key={i} block={block} />)}
            </div>
            <p className="text-sm">
              <a href="/guide.pdf" className="text-primary underline underline-offset-2" data-testid="guide-pdf">
                Download it as a PDF
              </a>{" "}
              <span className="text-muted">— the same thing, to keep or to print.</span>
            </p>
          </header>

          <Card className="p-5">
            <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-muted">What is in this guide</h2>
            <ol className="mt-3 space-y-1.5 list-decimal pl-5">
              {G.sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} className="text-primary underline-offset-2 hover:underline">{s.heading}</a>
                </li>
              ))}
            </ol>
          </Card>

          {G.sections.map((section, n) => (
            <section key={section.id} id={section.id} className="space-y-4 scroll-mt-20">
              <h2 className="font-display text-2xl font-semibold">
                <span className="text-muted mr-2">{n + 1}.</span>
                {section.heading}
              </h2>
              {section.blocks.map((block, i) => <Block key={i} block={block} />)}
            </section>
          ))}
        </div>
      </Container>
    </AppShell>
  );
}
