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
import { ImagePlus, X, Loader2 } from 'lucide-react';
import { prepareChatImage, imageFilesFromDataTransfer, MAX_CHAT_IMAGES } from '@/lib/chat-images';

// useChatImages — attachment state + intake for a composer. Returns
// { images, busy, addFiles, remove, clear, handlePaste, handleDrop }.
// `onError(message)` surfaces intake problems (toast).
export function useChatImages({ onError } = {}) {
  const [images, setImages] = useState([]);
  const [busy, setBusy] = useState(false);

  const addFiles = useCallback(async (files) => {
    const list = Array.from(files || []).slice(0, MAX_CHAT_IMAGES);
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
  }, [onError]);

  const remove = useCallback((idx) => {
    setImages((cur) => {
      const gone = cur[idx];
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return cur.filter((_, i) => i !== idx);
    });
  }, []);

  const clear = useCallback(() => {
    setImages((cur) => {
      for (const i of cur) if (i.previewUrl) URL.revokeObjectURL(i.previewUrl);
      return [];
    });
  }, []);

  // Wire these to the composer textarea / wrapper.
  const handlePaste = useCallback((e) => {
    const files = imageFilesFromDataTransfer(e.clipboardData);
    if (files.length) { e.preventDefault(); addFiles(files); }
  }, [addFiles]);
  const handleDrop = useCallback((e) => {
    const files = imageFilesFromDataTransfer(e.dataTransfer);
    if (files.length) { e.preventDefault(); addFiles(files); }
  }, [addFiles]);

  return { images, busy, addFiles, remove, clear, handlePaste, handleDrop };
}

// The thumbnails row + "+" picker rendered under a composer. Renders nothing
// when there are no images and the picker is disabled.
export function ImageAttachmentBar({ images = [], busy = false, disabled = false, onPickFiles, onRemove }) {
  const inputRef = useRef(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {images.map((img, i) => (
        // The whole thumbnail is the remove target (≥44px), with an X badge as
        // the affordance — no tiny corner button to miss on a phone.
        <button
          key={`${img.bytes}-${i}`}
          type="button"
          aria-label={`Remove image ${i + 1}${img.name ? ` (${img.name})` : ''}`}
          title="Tap to remove"
          onClick={() => onRemove(i)}
          className="group relative h-14 w-14 shrink-0 rounded-md border overflow-hidden"
        >
          <img src={img.previewUrl} alt="" className="h-full w-full object-cover" />
          <span className="pointer-events-none absolute right-0.5 top-0.5 rounded-full bg-background/90 border p-0.5 text-muted-foreground group-hover:text-foreground">
            <X className="h-3 w-3" />
          </span>
        </button>
      ))}
      <button
        type="button"
        aria-label="Attach images"
        title="Attach images (or paste / drop them into the message box)"
        disabled={disabled || busy || images.length >= MAX_CHAT_IMAGES}
        onClick={() => inputRef.current?.click()}
        className="inline-flex h-11 w-11 items-center justify-center rounded-md border text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={(e) => { onPickFiles(e.target.files); e.target.value = ''; }}
      />
    </div>
  );
}
