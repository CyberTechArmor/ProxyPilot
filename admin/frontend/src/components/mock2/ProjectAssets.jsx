// Project asset library — Flightdeck's Assets panel.
//
// Shaped like a chat on purpose: a chronological feed of what the operator has
// collected for this project (logos, screenshots, reference shots, copy, brand
// notes) with a composer pinned to the bottom. Adding an asset should feel like
// sending a message, not like filling in a form on a settings page.
//
// Everything here is handed to the build harness as reference context, so the
// panel says so plainly — an operator needs to know that what they drop in
// changes what the next build sees.
//
// MOBILE_FIRST: single column throughout, 44px targets, composer reachable at
// 360px, the feed is the only scrolling region.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import ImageLightbox from './ImageLightbox';
import {
  ImagePlus, Paperclip, FileText, Pin, PinOff, Trash2, Loader2, Send, X, Check, Pencil, ImageOff,
} from 'lucide-react';

// A thumbnail that says so when its bytes fail to load, instead of the
// browser's broken-image glyph over the caption (operator report). The click
// still works either way — the lightbox's open-in-new-tab is the diagnostic.
function AssetThumb({ src, alt }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (failed) {
    return (
      <span className="flex h-24 w-full flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground">
        <ImageOff className="h-4 w-4" />
        Preview unavailable — tap to open
      </span>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className="max-h-56 w-full object-contain"
    />
  );
}

// Mirrors ASSET_TAGS in mock2/project-assets-logic.js. Kept as a fallback only:
// the server sends the authoritative list with every load, so adding a tag
// backend-side does not require a frontend release.
const FALLBACK_TAGS = [
  { key: 'logo', label: 'Logo', kinds: ['image'] },
  { key: 'favicon', label: 'Favicon', kinds: ['image'] },
  { key: 'screenshot', label: 'Screenshot', kinds: ['image'] },
  { key: 'reference', label: 'Design reference', kinds: ['image'] },
  { key: 'photo', label: 'Photo / illustration', kinds: ['image'] },
  { key: 'copy', label: 'Copy / wording', kinds: ['content'] },
  { key: 'about', label: 'About this app', kinds: ['content'] },
  { key: 'brand', label: 'Brand & voice', kinds: ['content'] },
  { key: 'note', label: 'Note', kinds: ['content'] },
  { key: 'reference-file', label: 'Reference file', kinds: ['document'] },
  { key: 'website', label: 'Website export', kinds: ['document'] },
  { key: 'spec', label: 'Spec / requirements', kinds: ['document'] },
];

function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return d.toLocaleDateString();
}

// onSummary — called with { total, images, content, … } after every load, so a
// container (the assets modal) can show a live count without asking the API a
// second time and getting a different answer.
export default function ProjectAssets({ projectId, canEdit = false, onSummary = null }) {
  const [assets, setAssets] = useState([]);
  const [tags, setTags] = useState(FALLBACK_TAGS);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftTag, setDraftTag] = useState('note');
  const [editing, setEditing] = useState(null);      // id being renamed
  const [editValue, setEditValue] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [lightboxAt, setLightboxAt] = useState(null); // index into the image assets, or null

  const fileRef = useRef(null);
  const feedRef = useRef(null);
  const bottomRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await api.mock2ProjectAssets(projectId);
      setAssets(r.assets || []);
      if (Array.isArray(r.tags) && r.tags.length) setTags(r.tags);
      setSummary(r.summary || null);
      if (onSummary) onSummary(r.summary || { total: (r.assets || []).length });
      setError('');
    } catch (e) {
      setError(e?.message || 'Could not load the asset library.');
    } finally {
      setLoading(false);
    }
  }, [projectId, onSummary]);

  useEffect(() => { load(); }, [load]);

  // New items land at the bottom next to the composer, so follow them there —
  // but only when the reader is already at the bottom, so scrolling back
  // through the library is not yanked away mid-read.
  const wasAtBottom = useRef(true);
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      wasAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (wasAtBottom.current && bottomRef.current) bottomRef.current.scrollIntoView({ block: 'end' });
  }, [assets.length]);

  const contentTags = useMemo(() => tags.filter((t) => t.kinds.includes('content')), [tags]);
  const imageTags = useMemo(() => tags.filter((t) => t.kinds.includes('image')), [tags]);
  const documentTags = useMemo(() => tags.filter((t) => t.kinds.includes('document')), [tags]);
  const labelFor = useCallback((key) => (tags.find((t) => t.key === key) || {}).label || key, [tags]);

  const addFiles = useCallback(async (files) => {
    const list = Array.from(files || []);
    if (!list.length || !canEdit) return;
    setBusy(true);
    setError('');
    const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
    for (const f of list) {
      try {
        if (IMAGE_EXT.test(f.name || '')) {
          // Measure the image client-side: the dimensions ride along so the
          // harness context can say "logo.svg 240x60" without the server
          // decoding every upload.
          const dims = await new Promise((resolve) => {
            const img = new Image();
            const url = URL.createObjectURL(f);
            img.onload = () => { URL.revokeObjectURL(url); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
            img.onerror = () => { URL.revokeObjectURL(url); resolve({}); };
            img.src = url;
          });
          await api.mock2UploadProjectImage(projectId, f, { tag: 'reference', ...dims });
        } else if (/\.zip$/i.test(f.name || '')) {
          // A zip of reference material (e.g. a website export) — unpacked
          // server-side; each text file inside becomes its own asset.
          const out = await api.mock2UploadProjectArchive(projectId, f);
          const sk = out?.skipped || {};
          const skippedTotal = Object.values(sk).reduce((n, v) => n + (Number(v) || 0), 0);
          const notes = [];
          if (out?.warning) notes.push(out.warning);
          if (skippedTotal) notes.push(`Ingested ${out.ingested} file(s) from ${f.name}; skipped ${skippedTotal} (binaries, oversized, or dependency folders).`);
          if (notes.length) setError(notes.join(' '));
        } else {
          // Any other file is a reference document — the server accepts any
          // extension as long as the content is text.
          await api.mock2UploadProjectDocument(projectId, f);
        }
      } catch (e) {
        setError(e?.message || `Could not upload ${f.name}.`);
      }
    }
    setBusy(false);
    wasAtBottom.current = true;
    load();
  }, [projectId, canEdit, load]);

  const submitContent = useCallback(async () => {
    const body = draft.trim();
    if (!body || !canEdit) return;
    setBusy(true);
    setError('');
    try {
      await api.mock2AddProjectContent(projectId, { name: draftTitle.trim() || 'Note', body, tag: draftTag });
      setDraft(''); setDraftTitle('');
      wasAtBottom.current = true;
      load();
    } catch (e) {
      setError(e?.message || 'Could not save that content.');
    } finally {
      setBusy(false);
    }
  }, [draft, draftTitle, draftTag, projectId, canEdit, load]);

  const patch = useCallback(async (assetId, data) => {
    try {
      await api.mock2UpdateProjectAsset(projectId, assetId, data);
      load();
    } catch (e) { setError(e?.message || 'Could not update that asset.'); }
  }, [projectId, load]);

  const remove = useCallback(async (assetId) => {
    try {
      await api.mock2DeleteProjectAsset(projectId, assetId);
      setAssets((cur) => cur.filter((a) => a.id !== assetId));
    } catch (e) { setError(e?.message || 'Could not delete that asset.'); }
  }, [projectId]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const onPaste = useCallback((e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length) { e.preventDefault(); addFiles(files); }
  }, [addFiles]);

  return (
    <div
      className="flex flex-col h-full min-h-0 bg-background"
      onDragOver={(e) => { if (canEdit) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {/* Header: what this is and, crucially, that it reaches the build. */}
      <div className="shrink-0 border-b px-3 py-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm font-medium">Assets</div>
          {summary ? (
            <div className="text-[11px] text-muted-foreground">
              {summary.images} image{summary.images === 1 ? '' : 's'} · {summary.content} content
              {summary.documents ? ` · ${summary.documents} file${summary.documents === 1 ? '' : 's'}` : ''}
              {summary.bytes ? ` · ${fmtBytes(summary.bytes)}` : ''}
            </div>
          ) : null}
        </div>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Images, content, and reference files (any text file, or a zip of them) for this project. The build sees these as reference on every cycle.
        </p>
      </div>

      {error ? (
        <div className="shrink-0 mx-3 mt-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive flex items-start justify-between gap-2">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={() => setError('')} aria-label="Dismiss" className="shrink-0 p-1 -m-1"><X className="h-3.5 w-3.5" /></button>
        </div>
      ) : null}

      {/* The feed — the only scrolling region. */}
      <div ref={feedRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2.5">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading…</div>
        ) : assets.length === 0 ? (
          <div className="text-xs text-muted-foreground py-8 text-center">
            <ImagePlus className="h-6 w-6 mx-auto mb-2 opacity-40" />
            Nothing here yet. Drop an image, a reference file (.ts, .md, a spec…), or a zip of a site — or write the copy and brand notes the build should follow.
          </div>
        ) : assets.map((a) => (
          <div key={a.id} className={`rounded-lg border ${a.pinned ? 'border-primary/50 bg-primary/5' : 'bg-card'} overflow-hidden`}>
            {a.kind === 'image' ? (
              // Opens the LIGHTBOX (arrow through every image in the library)
              // instead of throwing the reader into a new tab.
              <button
                type="button"
                className="block w-full cursor-zoom-in bg-muted/40"
                onClick={() => setLightboxAt(assets.filter((x) => x.kind === 'image').findIndex((x) => x.id === a.id))}
                aria-label={`View ${a.name} full size`}
              >
                <AssetThumb src={api.mock2ProjectAssetRawUrl(projectId, a.id)} alt={a.body || a.name} />
              </button>
            ) : a.kind === 'document' ? (
              <div className="px-3 pt-2.5 text-[12px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
                {a.body || 'No summary yet — the build reads the full file at state/assets/ either way. (Summaries need a Summary model on the Connectors page; retried automatically.)'}
              </div>
            ) : (
              <div className="px-3 pt-2.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words">{a.body}</div>
            )}

            <div className="px-3 py-2 flex items-start justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                {editing === a.id ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { patch(a.id, { name: editValue }); setEditing(null); }
                        if (e.key === 'Escape') setEditing(null);
                      }}
                      className="min-h-[36px] rounded border bg-background px-2 text-xs w-40"
                      autoFocus
                    />
                    <button type="button" aria-label="Save name" className="p-2 -m-1 text-primary"
                      onClick={() => { patch(a.id, { name: editValue }); setEditing(null); }}>
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    // -my-2/py-2 keeps the visual line tight while giving the
                    // tap target its 44px of height (MOBILE_FIRST).
                    className="text-xs font-medium truncate max-w-[210px] text-left hover:underline disabled:no-underline py-2 -my-2 min-h-[44px] flex items-center"
                    disabled={!canEdit}
                    onClick={() => { setEditing(a.id); setEditValue(a.name); }}
                    title={canEdit ? 'Rename' : a.name}
                  >
                    {a.name}{canEdit ? <Pencil className="h-2.5 w-2.5 inline ml-1 opacity-50" /> : null}
                  </button>
                )}
                <div className="text-[10.5px] text-muted-foreground">
                  {labelFor(a.tag)}
                  {a.kind === 'image' && a.width ? ` · ${a.width}×${a.height}` : ''}
                  {a.size ? ` · ${fmtBytes(a.size)}` : ''}
                  {a.createdAt ? ` · ${fmtWhen(a.createdAt)}` : ''}
                </div>
              </div>

              {canEdit ? (
                <div className="flex items-center gap-0.5 shrink-0">
                  <select
                    value={a.tag || ''}
                    onChange={(e) => patch(a.id, { tag: e.target.value })}
                    aria-label={`Tag for ${a.name}`}
                    className="min-h-[44px] rounded border bg-background px-1.5 text-[11px] max-w-[120px]"
                  >
                    {(a.kind === 'image' ? imageTags : a.kind === 'document' ? documentTags : contentTags).map((t) => (
                      <option key={t.key} value={t.key}>{t.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => patch(a.id, { pinned: !a.pinned })}
                    aria-label={a.pinned ? `Unpin ${a.name}` : `Pin ${a.name}`}
                    title={a.pinned ? 'Unpin — pinned assets lead the build context' : 'Pin — put this first in the build context'}
                    className={`min-h-[44px] min-w-[44px] flex items-center justify-center rounded ${a.pinned ? 'text-primary' : 'text-muted-foreground'} hover:bg-muted`}
                  >
                    {a.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(a.id)}
                    aria-label={`Delete ${a.name}`}
                    className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-muted"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Composer — one control for both kinds: type content, or attach an image. */}
      {canEdit ? (
        <div className={`shrink-0 border-t p-2.5 space-y-2 ${dragOver ? 'bg-primary/10 ring-2 ring-inset ring-primary/40' : ''}`}>
          <div className="flex gap-2">
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="Title (optional)"
              aria-label="Content title"
              className="flex-1 min-w-0 min-h-[44px] rounded-md border bg-background px-2.5 text-xs"
            />
            <select
              value={draftTag}
              onChange={(e) => setDraftTag(e.target.value)}
              aria-label="Content type"
              className="min-h-[44px] rounded-md border bg-background px-2 text-xs max-w-[42%]"
            >
              {contentTags.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter breaks the line — the chat convention,
              // which is what this panel is shaped like.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submitContent(); }
            }}
            rows={2}
            placeholder="Write copy, brand voice, or what this app is for… (or paste / drop images, text files, or a zip)"
            className="w-full rounded-md border bg-background px-2.5 py-2 text-xs resize-y min-h-[60px]"
          />
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
            />
            <Button type="button" variant="outline" size="sm" className="min-h-[44px]"
              title="Attach images, text files (.ts, .md, a spec…), or a zip of a site"
              onClick={() => fileRef.current?.click()} disabled={busy}>
              <Paperclip className="h-3.5 w-3.5 mr-1.5" />Attach
            </Button>
            <div className="flex-1" />
            <Button type="button" size="sm" className="min-h-[44px]"
              onClick={submitContent} disabled={busy || !draft.trim()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1.5" />}
              Add
            </Button>
          </div>
        </div>
      ) : (
        <div className="shrink-0 border-t px-3 py-2 text-[11px] text-muted-foreground flex items-center gap-1.5">
          <FileText className="h-3.5 w-3.5" />Read-only — editor access is needed to change assets.
        </div>
      )}

      {lightboxAt != null ? (
        <ImageLightbox
          images={assets.filter((x) => x.kind === 'image').map((x) => ({
            url: api.mock2ProjectAssetRawUrl(projectId, x.id),
            name: x.name,
            label: labelFor(x.tag),
            caption: x.body || null,
          }))}
          index={lightboxAt}
          onClose={() => setLightboxAt(null)}
        />
      ) : null}
    </div>
  );
}
