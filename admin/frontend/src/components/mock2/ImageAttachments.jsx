// Image attachments for the Mock2 chat composers (multi-modal chat) — one
// implementation shared by the concept/design chat and the build chat so
// paste, drag-and-drop, and the "+" picker behave identically everywhere.
//
// The heavy lifting (downscale to the 1568px token sweet spot, WebP/JPEG
// re-encode) happens in lib/chat-images.js BEFORE anything leaves the browser.
//
// MOBILE_FIRST: 44px "+" button, thumbnails with a ≥44px effective remove
// target (padded hit area), wraps to multiple rows on 360px.

import { useCallback, useRef, useState } from 'react';
import { ImagePlus, Paperclip, X, Loader2 } from 'lucide-react';
import { prepareChatImage, partitionFilesFromDataTransfer, isChatImageFile, MAX_CHAT_IMAGES } from '@/lib/chat-images';

// useChatImages — attachment state + intake for a composer. Returns
// { images, busy, addFiles, remove, clear, handlePaste, handleDrop }.
// `onError(message)` surfaces intake problems (toast).
//
// `onDocumentFiles(files)` — when provided, NON-image files (a .ts, a .md, a
// zip of a site…) pasted/dropped/picked into the composer are handed to it
// instead of being silently ignored; the callers route them to the project
// asset library. Without it, non-images keep the old only-images error.
export function useChatImages({ onError, onDocumentFiles = null } = {}) {
  const [images, setImages] = useState([]);
  const [busy, setBusy] = useState(false);

  const addFiles = useCallback(async (files) => {
    const all = Array.from(files || []);
    const others = all.filter((f) => !isChatImageFile(f));
    if (others.length) {
      if (onDocumentFiles) onDocumentFiles(others);
      else if (onError) onError('Only JPEG, PNG, WebP, or GIF images can be attached.');
    }
    const list = all.filter(isChatImageFile).slice(0, MAX_CHAT_IMAGES);
    if (!list.length) return;
    setBusy(true);
    try {
      const prepared = [];
      for (const f of list) {
        try { prepared.push(await prepareChatImage(f)); }
        catch (err) { if (onError) onError(err.message); }
      }
      if (prepared.length) {
        setImages((cur) => {
          const room = MAX_CHAT_IMAGES - cur.length;
          if (room <= 0) {
            if (onError) onError(`At most ${MAX_CHAT_IMAGES} images per message.`);
            return cur;
          }
          if (prepared.length > room && onError) onError(`Only ${room} more image${room === 1 ? '' : 's'} fit on this message (max ${MAX_CHAT_IMAGES}).`);
          return [...cur, ...prepared.slice(0, room)];
        });
      }
    } finally { setBusy(false); }
  }, [onError, onDocumentFiles]);

  // previewUrl is a data: URL (the app CSP blocks blob:), so removal needs no
  // revoke bookkeeping — the string is garbage-collected with the state.
  const remove = useCallback((idx) => {
    setImages((cur) => cur.filter((_, i) => i !== idx));
  }, []);

  const clear = useCallback(() => setImages([]), []);

  // Replace one attachment IN PLACE (the annotate dialog swaps in the pinned
  // version) — order-stable, unlike remove+add which pushed it to the end.
  const replaceAt = useCallback(async (idx, file) => {
    try {
      const prepared = await prepareChatImage(file);
      setImages((cur) => cur.map((img, i) => (i === idx ? prepared : img)));
    } catch (err) { if (onError) onError(err.message); }
  }, [onError]);

  // Wire these to the composer textarea / wrapper. Text-only pastes carry no
  // files and fall through to the browser's normal paste.
  const intake = useCallback((e, dt) => {
    const { images: imgs, others } = partitionFilesFromDataTransfer(dt);
    const docs = onDocumentFiles ? others : [];
    if (!imgs.length && !docs.length) return;
    e.preventDefault();
    if (imgs.length) addFiles(imgs);
    if (docs.length) onDocumentFiles(docs);
  }, [addFiles, onDocumentFiles]);
  const handlePaste = useCallback((e) => intake(e, e.clipboardData), [intake]);
  const handleDrop = useCallback((e) => intake(e, e.dataTransfer), [intake]);

  return { images, busy, addFiles, remove, replaceAt, clear, handlePaste, handleDrop };
}

// The thumbnails row + "+" picker rendered under a composer. Renders nothing
// when there are no images and the picker is disabled.
//
// `allowDocuments` — the composer's intake also routes text files / zips to
// the asset library (its hook got onDocumentFiles), so the picker accepts any
// file and says so; without it the picker stays images-only.
export function ImageAttachmentBar({ images = [], busy = false, disabled = false, onPickFiles, onRemove, onAnnotate = null, allowDocuments = false }) {
  const inputRef = useRef(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {images.map((img, i) => (
        // With onAnnotate wired, tapping the IMAGE opens the pin/comment
        // editor and the corner X removes (user request); without it the
        // whole tile removes, as before.
        <div key={`${img.bytes}-${i}`} className="relative h-16 w-16 shrink-0">
          <button
            type="button"
            aria-label={onAnnotate ? `Annotate image ${i + 1}${img.name ? ` (${img.name})` : ''}` : `Remove image ${i + 1}`}
            title={onAnnotate ? 'Tap to drop pins + comments on this image' : 'Tap to remove'}
            onClick={() => (onAnnotate ? onAnnotate(i) : onRemove(i))}
            className="h-full w-full rounded-md border overflow-hidden"
          >
            <img src={img.previewUrl} alt="" className="h-full w-full object-cover" />
          </button>
          <button
            type="button"
            aria-label={`Remove image ${i + 1}`}
            title="Remove"
            onClick={(e) => { e.stopPropagation(); onRemove(i); }}
            className="absolute -right-1.5 -top-1.5 rounded-full bg-background border p-1.5 text-muted-foreground hover:text-foreground shadow-sm"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        aria-label={allowDocuments ? 'Attach images or reference files' : 'Attach images'}
        title={allowDocuments
          ? 'Attach images, text files (.ts, .md, …), or a zip of a site — or paste / drop them into the message box. Files and zips go to the project assets for the build to reference.'
          : 'Attach images (or paste / drop them into the message box)'}
        disabled={disabled || busy || (!allowDocuments && images.length >= MAX_CHAT_IMAGES)}
        onClick={() => inputRef.current?.click()}
        className="inline-flex h-11 w-11 items-center justify-center rounded-md border text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" />
          : allowDocuments ? <Paperclip className="h-4 w-4" /> : <ImagePlus className="h-4 w-4" />}
      </button>
      <input
        ref={inputRef}
        type="file"
        {...(allowDocuments ? {} : { accept: 'image/jpeg,image/png,image/webp,image/gif' })}
        multiple
        className="hidden"
        onChange={(e) => { onPickFiles(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
}
