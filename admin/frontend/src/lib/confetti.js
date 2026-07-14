// A tiny, self-contained confetti burst — no dependency, no external asset (CSP).
//
// One call paints a short-lived full-screen canvas overlay of falling, spinning
// paper, then removes itself. Used to celebrate a project coming online for the
// first time. Kept deliberately minimal: a few hundred particles under simple
// gravity, ~2.5s, pointer-events:none so it never blocks the UI.

export function fireConfetti({ particleCount = 160, durationMs = 2500 } = {}) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  // Respect reduced-motion — skip the animation entirely.
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch { /* matchMedia unavailable — proceed */ }

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999';
  canvas.setAttribute('aria-hidden', 'true');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  document.body.appendChild(canvas);

  const colors = ['#22c55e', '#06b6d4', '#8b5cf6', '#f59e0b', '#ef4444', '#3b82f6'];
  // Deterministic-enough pseudo-random (Math.random is fine here — purely visual).
  const rand = (a, b) => a + Math.random() * (b - a);
  const particles = Array.from({ length: particleCount }, () => ({
    x: rand(0, w),
    y: rand(-h * 0.3, 0),
    r: rand(4, 9),
    color: colors[Math.floor(rand(0, colors.length))],
    vx: rand(-1.4, 1.4),
    vy: rand(2.2, 5.2),
    rot: rand(0, Math.PI * 2),
    vrot: rand(-0.2, 0.2),
  }));

  const start = performance.now();
  let raf = 0;
  const tick = (now) => {
    const t = now - start;
    ctx.clearRect(0, 0, w, h);
    const fade = t > durationMs - 600 ? Math.max(0, (durationMs - t) / 600) : 1;
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05; // gravity
      p.rot += p.vrot;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.6);
      ctx.restore();
    }
    if (t < durationMs) {
      raf = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(raf);
      canvas.remove();
    }
  };
  raf = requestAnimationFrame(tick);
}
