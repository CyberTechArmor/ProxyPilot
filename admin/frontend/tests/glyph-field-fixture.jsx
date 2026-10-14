// Disposable visual fixture for the GlyphField background. Not an app route.
// Query: ?theme=midnight|latte|office  &seed=N  &paused=1  &fps= &coverage= &scramble= &speed=
// Unset options are passed as `undefined` on purpose: they must keep the defaults.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { GlyphField } from '../src/components/ui/glyph-field';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../src/components/ui/card';
import '../src/index.css';

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') || 'midnight';
document.documentElement.dataset.theme = theme;
document.documentElement.classList.toggle('dark', theme === 'midnight');
window.__setTheme = (next) => {
  document.documentElement.dataset.theme = next;
  document.documentElement.classList.toggle('dark', next === 'midnight');
};

function Fixture() {
  return (
    <main className="relative isolate flex min-h-viewport items-center justify-center overflow-hidden bg-background p-4">
      <GlyphField seed={Number(params.get('seed') || 7)} paused={params.has('paused')} fps={params.has('fps') ? Number(params.get('fps')) : undefined} coverage={params.has('coverage') ? Number(params.get('coverage')) : undefined} scramble={params.has('scramble') ? Number(params.get('scramble')) : undefined} speed={params.has('speed') ? Number(params.get('speed')) : undefined} />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>ProxyPilot</CardTitle>
          <CardDescription>GlyphField background fixture</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">Content sits above the field and stays clickable.</CardContent>
      </Card>
    </main>
  );
}
createRoot(document.getElementById('root')).render(<Fixture />);
