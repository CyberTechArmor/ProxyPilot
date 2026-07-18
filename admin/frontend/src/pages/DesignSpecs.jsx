// Design specifications — a visual, self-explanatory reference for the design
// presets a project can be born with: live swatches, typography, radii, shadow
// and a mini preview rendered WITH each preset's own tokens, plus a short
// explanation of where the standards live and how builds consume them.
//
// Reached from Projects (section card) and from a project's Details tab; when
// linked as /projects/design?preset=<key> the matching preset is highlighted.
//
// MOBILE_FIRST: single column on mobile, two-up on lg; no fixed widths; the
// preview blocks size to their container.

import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Loader2, Palette } from 'lucide-react';

// One color chip: swatch + name + hex. Small but touch-friendly enough for a
// reference page (read-only, no 44px requirement — nothing is interactive).
function Swatch({ name, value }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="h-6 w-6 shrink-0 rounded border" style={{ background: value, borderColor: 'rgba(128,128,128,0.35)' }} />
      <span className="min-w-0 text-xs">
        <span className="block truncate font-medium">{name}</span>
        <span className="block truncate font-mono text-[10px] text-muted-foreground uppercase">{value}</span>
      </span>
    </div>
  );
}

// A mini app preview rendered entirely from the preset's tokens — the fastest
// honest answer to "what does this look like".
function Preview({ tokens }) {
  const c = tokens?.colors || {};
  const t = tokens?.typography || {};
  const r = tokens?.radius || {};
  const shadow = tokens?.shadow?.card || 'none';
  return (
    <div
      className="w-full overflow-hidden rounded-md border"
      style={{ background: c.background, fontFamily: t.fontFamily, fontSize: t.baseSize, borderColor: c.border }}
    >
      <div className="flex items-center justify-between px-3 py-2" style={{ background: c.surface, borderBottom: `1px solid ${c.border}` }}>
        <span style={{ color: c.text, fontFamily: t.headingFamily, fontWeight: 600 }}>App name</span>
        <span
          className="px-2 py-0.5 text-[11px]"
          style={{ background: c.accent, color: c.primaryText || '#fff', borderRadius: '999px' }}
        >
          badge
        </span>
      </div>
      <div className="p-3">
        <div className="p-3" style={{ background: c.surface, borderRadius: r.lg, boxShadow: shadow, border: `1px solid ${c.border}` }}>
          <p style={{ color: c.text, fontFamily: t.headingFamily, fontWeight: 600, marginBottom: 4 }}>Card heading</p>
          <p className="text-xs" style={{ color: c.muted, marginBottom: 10 }}>
            Muted supporting text on a surface card.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-3 py-1.5 text-xs" style={{ background: c.primary, color: c.primaryText || '#fff', borderRadius: r.md }}>
              Primary action
            </span>
            <span className="px-3 py-1.5 text-xs" style={{ background: 'transparent', color: c.text, border: `1px solid ${c.border}`, borderRadius: r.md }}>
              Secondary
            </span>
            <span className="text-xs" style={{ color: c.success }}>success</span>
            <span className="text-xs" style={{ color: c.danger }}>danger</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DesignSpecs() {
  const [presets, setPresets] = useState(null);
  const [params] = useSearchParams();
  const highlight = params.get('preset') || null;

  const load = useCallback(async () => {
    try {
      const res = await api.mock2DesignPresets();
      setPresets(res.presets || []);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error('load design presets failed:', err);
      setPresets([]);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="sm" className="h-11 sm:h-9">
          <Link to="/projects"><ArrowLeft className="h-4 w-4 mr-1" /> Projects</Link>
        </Button>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><Palette className="h-6 w-6" /> Design specifications</h1>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">How the design standards work</CardTitle>
          <CardDescription className="space-y-1.5">
            <span className="block">
              Every project is born with one of the presets below (chosen at New project). Its tokens are written
              into the project as <code className="text-xs">state/design-tokens.json</code> plus a ready stylesheet{' '}
              <code className="text-xs">state/design.css</code>, and the scaffold&apos;s shared shell
              (<code className="text-xs">public/base.css</code> + <code className="text-xs">public/app-shell.html</code>) is built from those tokens.
            </span>
            <span className="block">
              Builds are bound to them: the build runner&apos;s instructions order it to load the stylesheet, match the
              tokens, and build screens on the shell — never invent a different look. Approving a mockup re-extracts
              tokens from the approved design, so the app follows what you approved.
            </span>
          </CardDescription>
        </CardHeader>
      </Card>

      {presets == null ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {presets.map((p) => {
            const c = p.tokens?.colors || {};
            const t = p.tokens?.typography || {};
            const r = p.tokens?.radius || {};
            const isCurrent = highlight && p.key === highlight;
            return (
              <Card key={p.key} className={isCurrent ? 'border-primary ring-1 ring-primary/30' : ''}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex flex-wrap items-center gap-2">
                    {p.name}
                    {isCurrent ? <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">this project&apos;s preset</span> : null}
                    {p.key === 'portal-blue' ? <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">default</span> : null}
                  </CardTitle>
                  <CardDescription>{p.description}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Preview tokens={p.tokens} />
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
                    {Object.entries(c).map(([name, value]) => <Swatch key={name} name={name} value={value} />)}
                  </div>
                  <p className="text-[11px] text-muted-foreground break-words">
                    Type: {t.baseSize} · {String(t.fontFamily || '').split(',')[0].replace(/["']/g, '') || 'system'} — Radii: {[r.sm, r.md, r.lg].filter(Boolean).join(' / ')} — Shadow: {p.tokens?.shadow?.card ? 'soft layered card shadow' : 'none'}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
