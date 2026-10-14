import * as React from "react"
import { cn } from "@/lib/utils"
import { mountGlyphField } from "@/lib/glyph-field"

// Decorative ambient background: drifting clouds of random monospace glyphs
// (see lib/glyph-field.js for the options and their defaults). It fills its
// nearest positioned ancestor, sits behind that ancestor's content (-z-10)
// and never takes pointer events. The ancestor needs `isolate` (or another
// stacking context), otherwise the canvas drops behind its background:
//
//   <main className="relative isolate min-h-viewport overflow-hidden bg-background">
//     <GlyphField />
//     …content…
//   </main>
//
// The glyph colour is the CSS text colour (text-muted-foreground by default),
// so it follows the Midnight/Latte/Office palette; pass e.g. "text-primary" to
// tint it. Motion stops under prefers-reduced-motion, in hidden tabs and off
// screen. Changing `seed` starts a new field; other options apply live.
const GlyphField = React.forwardRef(({ className, seed, ...options }, ref) => {
  const canvasRef = React.useRef(null)
  const fieldRef = React.useRef(null)

  React.useImperativeHandle(ref, () => canvasRef.current)

  React.useEffect(() => {
    const field = mountGlyphField(canvasRef.current, { ...options, seed })
    fieldRef.current = field
    return () => {
      field.destroy()
      fieldRef.current = null
    }
    // Only the seed recreates the field; the effect below pushes the rest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed])

  React.useEffect(() => {
    fieldRef.current?.update(options)
  })

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 -z-10 h-full w-full select-none text-muted-foreground",
        className
      )}
    />
  )
})
GlyphField.displayName = "GlyphField"

export { GlyphField }
