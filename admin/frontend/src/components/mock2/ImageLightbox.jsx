// ImageLightbox — look at a chat image properly, without leaving the chat.
//
// Chat thumbnails are 96px tall and cropped (object-cover). For a screenshot —
// which is what most of them are — that is unreadable, and the old behaviour
// (open in a new tab) throws the reader out of the conversation and loses the
// caption and the surrounding messages.
//
// Handles a SET of images, so a desktop+mobile screenshot review is arrowed
// through rather than opened one at a time.
//
// MOBILE_FIRST: fills the screen, 44px controls, swipe-free arrows placed where
// a thumb reaches, and it never traps the reader — backdrop, Escape and an
// explicit close all dismiss it.

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Download, ExternalLink } from 'lucide-react';

export default function ImageLightbox({ images = [], index = 0, onClose }) {
  const [i, setI] = useState(index);
  const [zoom, setZoom] = useState(false);

  useEffect(() => { setI(index); setZoom(false); }, [index, images]);

  const count = images.length;
  const cur = images[i] || null;
  const go = useCallback((delta) => {
    setZoom(false);
    setI((n) => (count ? (n + delta + count) % count : 0));
  }, [count]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    // The page behind must not scroll while the lightbox owns the screen.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [go, onClose]);

  if (!cur) return null;

  const node = (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/90"
      role="dialog"
      aria-modal="true"
      aria-label={cur.name || 'Image'}
      // Only a click on the BACKDROP closes — a click that started on the image
      // (a drag to pan, a mis-tap) must not dismiss what you are trying to read.
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-2 text-white">
        <span className="min-w-0 flex-1 truncate text-xs" title={cur.name || ''}>
          {cur.name || 'Image'}
          {cur.label ? <span className="ml-2 text-white/60">{cur.label}</span> : null}
        </span>
        {count > 1 ? <span className="shrink-0 text-[11px] text-white/60">{i + 1} / {count}</span> : null}
        {cur.url ? (
          <>
            <a
              href={cur.url} target="_blank" rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="flex h-11 w-11 items-center justify-center rounded hover:bg-white/10"
              aria-label="Open in a new tab" title="Open in a new tab"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
            <a
              href={cur.url} download={cur.name || 'image.png'}
              onClick={(e) => e.stopPropagation()}
              className="flex h-11 w-11 items-center justify-center rounded hover:bg-white/10"
              aria-label="Download this image" title="Download"
            >
              <Download className="h-4 w-4" />
            </a>
          </>
        ) : null}
        <button
          type="button" onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded hover:bg-white/10"
          aria-label="Close" title="Close (Esc)"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className={`relative flex flex-1 min-h-0 items-center justify-center ${zoom ? 'overflow-auto' : 'overflow-hidden'} px-2 pb-2`}>
        {/* A screenshot is tall and thin: fit-to-screen makes it unreadable, so a
            tap toggles to full width and lets the container scroll. */}
        <img
          src={cur.url}
          alt={cur.name || 'Image'}
          onClick={(e) => { e.stopPropagation(); setZoom((v) => !v); }}
          className={zoom ? 'w-full max-w-none cursor-zoom-out' : 'max-h-full max-w-full object-contain cursor-zoom-in'}
        />
        {count > 1 ? (
          <>
            <button
              type="button" onClick={(e) => { e.stopPropagation(); go(-1); }}
              className="absolute left-1 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70"
              aria-label="Previous image"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
            <button
              type="button" onClick={(e) => { e.stopPropagation(); go(1); }}
              className="absolute right-1 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70"
              aria-label="Next image"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          </>
        ) : null}
      </div>

      {cur.caption ? (
        <p className="shrink-0 px-3 pb-3 text-center text-[11px] text-white/70">{cur.caption}</p>
      ) : null}
    </div>
  );

  // Portalled to <body>: the chat lives inside several overflow-hidden,
  // transformed panels, any one of which would clip a fixed overlay.
  return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
}
