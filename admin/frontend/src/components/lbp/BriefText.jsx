// Lean BEAF Pro — styled, linkified renderer for AI brief / answer text.
//
// The model returns light markdown (a **heading**, • or - bullets, **bold**).
// We render that with real styling instead of a raw pre-wrap blob, and we make
// the grounded references clickable:
//   • citation tokens [activity #N] / [report #N] → jump to the owning project
//     (activity citations open its Activity tab, reports open Metrics), and
//   • project-name mentions → open that project.
// `refs` (from the brief/ask API) maps record ids → project ids and lists the
// project names. No markdown dependency — a small deterministic parser, so the
// output is predictable and safe (no raw HTML is ever injected).

import { Fragment } from 'react';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Split a run of inline text into React nodes: **bold**, [activity/report #N]
// citations (clickable), and project-name mentions (clickable). Everything else
// is plain text.
function renderInline(str, refs, onOpen, keyBase) {
  const projects = refs?.projects || [];
  const activityMap = refs?.activity || {};
  const reportMap = refs?.report || {};

  // First split on bold + citations (structural tokens), keeping delimiters.
  const MASTER = /(\*\*[^*]+\*\*|\[(?:activity|report)\s*#\d+\])/g;
  const pieces = String(str).split(MASTER).filter((p) => p !== '');

  // Project-name matcher, longest first (refs.projects is pre-sorted longest
  // first server-side; guard anyway).
  const names = projects.map((p) => p.name).filter(Boolean).sort((a, b) => b.length - a.length);
  const nameRe = names.length ? new RegExp(`(${names.map(escapeRe).join('|')})`, 'g') : null;
  const idByName = new Map(projects.map((p) => [p.name, p.id]));

  const linkifyNames = (text, kb) => {
    if (!nameRe) return [text];
    const out = [];
    const parts = text.split(nameRe);
    parts.forEach((part, i) => {
      if (idByName.has(part)) {
        const pid = idByName.get(part);
        out.push(
          <button
            key={`${kb}-n${i}`}
            type="button"
            onClick={() => onOpen?.(pid)}
            className="font-semibold text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
          >
            {part}
          </button>,
        );
      } else if (part) {
        out.push(<Fragment key={`${kb}-t${i}`}>{part}</Fragment>);
      }
    });
    return out;
  };

  return pieces.map((piece, i) => {
    const kb = `${keyBase}-${i}`;
    const bold = /^\*\*([^*]+)\*\*$/.exec(piece);
    if (bold) {
      return <strong key={kb} className="font-bold">{linkifyNames(bold[1], kb)}</strong>;
    }
    const cite = /^\[(activity|report)\s*#(\d+)\]$/.exec(piece);
    if (cite) {
      const kind = cite[1].toLowerCase();
      const id = Number(cite[2]);
      const pid = kind === 'activity' ? activityMap[id] : reportMap[id];
      const tab = kind === 'activity' ? 'activity' : 'metrics';
      const label = `${kind} #${id}`;
      if (pid) {
        return (
          <button
            key={kb}
            type="button"
            onClick={() => onOpen?.(pid, tab)}
            title={`Open ${kind} #${id} on its project`}
            className="mx-0.5 inline-flex items-center rounded bg-primary/10 px-1.5 py-0.5 align-baseline font-mono text-[11px] font-semibold text-primary hover:bg-primary/20"
          >
            {label}
          </button>
        );
      }
      return (
        <span key={kb} className="mx-0.5 rounded bg-muted px-1.5 py-0.5 align-baseline font-mono text-[11px] text-muted-foreground">{label}</span>
      );
    }
    return <Fragment key={kb}>{linkifyNames(piece, kb)}</Fragment>;
  });
}

export default function BriefText({ text, refs, onOpen, className = '' }) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');

  // Group lines into blocks: headings, bullet lists, and paragraphs.
  const blocks = [];
  let list = null;
  let para = null;
  const flushList = () => { if (list) { blocks.push({ type: 'ul', items: list }); list = null; } };
  const flushPara = () => { if (para && para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = null; } };

  for (const line of lines) {
    const t = line.trim();
    if (t === '') { flushList(); flushPara(); continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(t) || (/^\*\*[^*]+\*\*$/.test(t) ? [null, t.replace(/^\*\*|\*\*$/g, '')] : null);
    const bullet = /^[•\-*]\s+(.*)$/.exec(t) || /^\d+\.\s+(.*)$/.exec(t);
    if (heading) {
      flushList(); flushPara();
      blocks.push({ type: 'h', text: heading[1] });
    } else if (bullet) {
      flushPara();
      if (!list) list = [];
      list.push(bullet[1]);
    } else {
      flushList();
      if (!para) para = [];
      para.push(t);
    }
  }
  flushList(); flushPara();

  return (
    <div className={`space-y-2 text-sm leading-relaxed ${className}`}>
      {blocks.map((b, i) => {
        if (b.type === 'h') return <p key={i} className="text-sm font-bold">{renderInline(b.text, refs, onOpen, `h${i}`)}</p>;
        if (b.type === 'ul') {
          return (
            <ul key={i} className="space-y-1">
              {b.items.map((it, j) => (
                <li key={j} className="flex gap-2">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary/60" />
                  <span className="min-w-0">{renderInline(it, refs, onOpen, `l${i}-${j}`)}</span>
                </li>
              ))}
            </ul>
          );
        }
        return <p key={i}>{renderInline(b.text, refs, onOpen, `p${i}`)}</p>;
      })}
    </div>
  );
}
