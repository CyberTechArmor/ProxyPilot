import { Button } from '@/components/ui/button';
import { useId } from 'react';

export function Action({children,className='',variant='default',...props}) {
  const contrast=variant==='default'?'bg-[color-mix(in_srgb,hsl(var(--primary)),black_25%)] hover:bg-[color-mix(in_srgb,hsl(var(--primary)),black_35%)]':'';
  return <Button variant={variant} className={`min-h-11 h-auto sm:min-h-9 whitespace-normal rounded-md px-4 text-sm font-medium ${contrast} ${className}`} {...props}>{children}</Button>;
}
export function Panel({title,children,className='',icon:Icon,description,actions}) {
  return <section className={`operations-card rounded-md border bg-card p-4 sm:p-5 space-y-4 min-w-0 ${className}`}><header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3"><div className="min-w-0"><h2 className="text-lg font-semibold flex items-center gap-2">{Icon&&<Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true"/>}{title}</h2>{description&&<p className="text-sm text-muted-foreground mt-1">{description}</p>}</div>{actions}</header>{children}</section>;
}
export function Field({label,textarea=false,...props}) {
  const Tag=textarea?'textarea':'input',id=useId();
  return <div className="space-y-2"><label htmlFor={id} className="block text-sm font-medium">{label}</label><Tag id={id} className="flex min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" {...props}/></div>;
}
export function Choice({label,children,...props}) {
  const id=useId();
  return <div className="space-y-2"><label htmlFor={id} className="block text-sm font-medium">{label}</label><select id={id} className="min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" {...props}>{children}</select></div>;
}
export function GuideText({version}) {
  return <div className="space-y-3 min-w-0"><h3 className="font-medium break-words">{version.title}</h3><pre className="whitespace-pre-wrap break-words font-sans text-sm rounded-md bg-muted p-3 [overflow-wrap:anywhere]">{version.instructions}</pre><p className="text-xs text-muted-foreground break-all">SHA-256: {version.content_hash}</p></div>;
}
export const roleNames=['viewer','operator','editor','reviewer'];
