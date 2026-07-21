// Harness guide — the operator-facing document that explains every step of
// the Mock2 pipeline (models, prompts, effort, classifiers, gates) from
// Concept through Build and the post-build passes, so the harness can be
// EVALUATED, not just used.
//
// The shipped text lives with the backend code and follows upgrades. An admin
// can take the document over here (Edit → Save stores the copy server-side);
// "Reset to shipped" clears the edit and the page falls back to the version
// that matches the running code.
//
// MOBILE_FIRST: single column; tables and code blocks scroll inside their own
// container, never the page; 44px touch targets; edit mode is a full-width
// textarea that works at 360px.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Loader2, Pencil, RotateCcw, Save, X } from 'lucide-react';

// Document-scale markdown styling (the chat Markdown component renders
// bubble-scale headings — a long reference document needs real hierarchy).
// Same XSS posture: react-markdown does not render raw HTML.
const docComponents = {
  h1: ({ children }) => <h1 className="mt-6 first:mt-0 mb-3 text-xl font-bold sm:text-2xl">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-8 first:mt-0 mb-2 border-b pb-1 text-lg font-semibold sm:text-xl">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-5 mb-1.5 text-base font-semibold sm:text-lg">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-4 mb-1 text-sm font-semibold sm:text-base">{children}</h4>,
  p: ({ children }) => <p className="my-2 text-sm leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-2 ml-5 list-disc space-y-1 text-sm">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 ml-5 list-decimal space-y-1 text-sm">{children}</ol>,
  li: ({ children }) => <li className="break-words leading-relaxed">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:opacity-80 break-all">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-primary/50 pl-3 text-sm text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-6 border-border" />,
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-md border bg-muted/50 p-3 font-mono text-xs leading-relaxed [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-xs sm:text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-r last:border-r-0 bg-muted/60 px-2 py-1.5 text-left font-semibold align-bottom">{children}</th>,
  td: ({ children }) => <td className="border-b border-r last:border-r-0 px-2 py-1.5 align-top">{children}</td>,
};

export default function HarnessGuide() {
  const { toast } = useToast();
  const [doc, setDoc] = useState(null); // { content, edited, updated_at } | null while loading
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    try {
      setDoc(await api.mock2GetHarnessGuide());
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load harness guide failed:', err);
      setDoc({ content: '', edited: false, updated_at: null, error: true });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const startEdit = () => {
    setDraft(doc?.content || '');
    setEditing(true);
    setConfirmReset(false);
  };

  const save = async () => {
    if (!draft.trim()) {
      toast({ variant: 'destructive', title: 'Empty document', description: 'Use "Reset to shipped" to drop your edit instead of saving an empty page.' });
      return;
    }
    setBusy(true);
    try {
      setDoc(await api.mock2SetHarnessGuide(draft));
      setEditing(false);
      toast({ title: 'Harness guide saved', description: 'Your copy now overrides the shipped document.' });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Save failed', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      setDoc(await api.mock2SetHarnessGuide(''));
      setEditing(false);
      setConfirmReset(false);
      toast({ title: 'Reset to shipped', description: 'The document again tracks the running code.' });
    } catch (err) {
      toast({ variant: 'destructive', title: 'Reset failed', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <Button asChild variant="ghost" size="sm" className="h-11 sm:h-9 -ml-2 mb-1">
            <Link to="/projects"><ArrowLeft className="h-4 w-4 mr-1" /> Projects</Link>
          </Button>
          <h1 className="text-xl font-bold sm:text-2xl">Harness guide</h1>
          <p className="text-sm text-muted-foreground">
            Every pipeline step — model, prompt, effort, classifiers, gates — from design to build.
          </p>
        </div>
        {doc && !editing && (
          <div className="flex flex-wrap items-center gap-2">
            {doc.edited ? (
              <span className="inline-flex items-center rounded-full border border-amber-500/50 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                Edited copy{doc.updated_at ? ` · ${new Date(doc.updated_at).toLocaleDateString()}` : ''}
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground">
                Shipped with this version
              </span>
            )}
            <Button variant="outline" className="h-11 sm:h-10" onClick={startEdit}>
              <Pencil className="h-4 w-4 mr-1" /> Edit
            </Button>
            {doc.edited && (confirmReset ? (
              <Button variant="destructive" className="h-11 sm:h-10" disabled={busy} onClick={reset}>
                {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-1" />}
                Confirm reset
              </Button>
            ) : (
              <Button variant="outline" className="h-11 sm:h-10" onClick={() => setConfirmReset(true)}>
                <RotateCcw className="h-4 w-4 mr-1" /> Reset to shipped
              </Button>
            ))}
          </div>
        )}
      </div>

      {doc == null ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : editing ? (
        <Card>
          <CardContent className="space-y-3 p-3 sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Markdown. Saving stores your copy server-side; the shipped document is untouched and stays available via Reset.
              </p>
              <span className="text-xs tabular-nums text-muted-foreground">{draft.length.toLocaleString()} chars</span>
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="min-h-[60vh] w-full resize-y rounded-md border bg-background p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" className="h-11 sm:h-10" disabled={busy} onClick={() => setEditing(false)}>
                <X className="h-4 w-4 mr-1" /> Cancel
              </Button>
              <Button className="h-11 sm:h-10" disabled={busy} onClick={save}>
                {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />} Save
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : doc.error ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            The harness guide could not be loaded. Check that this host has the Projects module enabled and that you are an admin.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-4 sm:p-6">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={docComponents}>
              {doc.content}
            </ReactMarkdown>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
