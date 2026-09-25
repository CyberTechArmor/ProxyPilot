import { Button } from '@/components/ui/button';
import { useId } from 'react';

export function Action({children,className='',variant='default',...props}) {
  const contrast=variant==='default'?'bg-[color-mix(in_srgb,hsl(var(--primary)),black_25%)] hover:bg-[color-mix(in_srgb,hsl(var(--primary)),black_35%)]':'';
  return <Button variant={variant} className={`min-h-11 h-auto whitespace-normal ${contrast} ${className}`} {...props}>{children}</Button>;
}
export function Panel({title,children}) {
  return <section className="rounded-lg border bg-card p-4 sm:p-6 space-y-4 min-w-0"><h2 className="text-lg font-semibold">{title}</h2>{children}</section>;
}
export function Field({label,textarea=false,...props}) {
  const Tag=textarea?'textarea':'input',id=useId();
  return <div className="space-y-2"><label htmlFor={id} className="block text-sm font-medium">{label}</label><Tag id={id} className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" {...props}/></div>;
}
export function Choice({label,children,...props}) {
  const id=useId();
  return <div className="space-y-2"><label htmlFor={id} className="block text-sm font-medium">{label}</label><select id={id} className="min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" {...props}>{children}</select></div>;
}
export function GuideText({version}) {
  return <div className="space-y-3 min-w-0"><h3 className="font-medium break-words">{version.title}</h3><pre className="whitespace-pre-wrap break-words font-sans text-sm rounded-md bg-muted p-3 [overflow-wrap:anywhere]">{version.instructions}</pre><p className="text-xs text-muted-foreground break-all">SHA-256: {version.content_hash}</p></div>;
}
export const roleNames=['viewer','operator','editor','reviewer'];
