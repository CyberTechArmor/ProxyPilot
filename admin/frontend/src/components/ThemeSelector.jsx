import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, Palette } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/context/ThemeContext';
import { THEMES } from '@/lib/theme';

export function ThemeSelector({ className = '' }) {
  const { theme, setTheme } = useTheme();
  const selected = THEMES.find(value => value.id === theme);
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild><Button variant="ghost" size="icon" className={`h-11 w-11 shrink-0 ${className}`} aria-label={`Color theme: ${selected.name}`} title={`Color theme: ${selected.name}`}><Palette className="h-5 w-5" aria-hidden="true" /></Button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-44 rounded-lg border bg-popover text-popover-foreground p-1 shadow-lg">
      <DropdownMenu.Label className="px-3 py-2 text-sm font-semibold">Color theme</DropdownMenu.Label>
      <DropdownMenu.RadioGroup value={theme} onValueChange={setTheme} aria-label="Color theme">
        {THEMES.map(value => <DropdownMenu.RadioItem key={value.id} value={value.id} className="relative flex min-h-11 cursor-pointer items-center rounded-md py-2 pl-9 pr-4 text-sm outline-none focus:bg-accent focus:text-accent-foreground data-[state=checked]:bg-accent">
          <DropdownMenu.ItemIndicator className="absolute left-3"><Check className="h-4 w-4" aria-hidden="true" /></DropdownMenu.ItemIndicator>{value.name}
        </DropdownMenu.RadioItem>)}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
