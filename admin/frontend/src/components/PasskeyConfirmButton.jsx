import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Fingerprint, Loader2 } from 'lucide-react';
import { getActionAssertion, isPasskeySupported } from '@/lib/passkey';
import { useToast } from '@/hooks/use-toast';

// Inline "Verify with passkey" button for destructive-action dialogs.
// Renders as null when:
//   - the operator has no registered passkey (hasPasskey=false), or
//   - the browser doesn't support PublicKeyCredential
// so the parent dialog falls through to the existing TOTP input.
//
// On click it asks the backend for a fresh challenge, runs the
// WebAuthn ceremony, and hands the resulting assertion to the parent
// via onAssertion(assertion). The parent then submits the destructive
// action with `passkeyAssertion: assertion` instead of `totpCode`.
export default function PasskeyConfirmButton({
  hasPasskey,
  onAssertion,
  disabled = false,
  className = '',
  label = 'Verify with passkey',
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  if (!hasPasskey || !isPasskeySupported()) return null;

  const handleClick = async () => {
    setBusy(true);
    try {
      const result = await getActionAssertion();
      if (!result.ok) {
        if (result.code !== 'CANCELLED') {
          toast({
            variant: 'destructive',
            title: 'Passkey failed',
            description: result.message,
          });
        }
        return;
      }
      await onAssertion(result.assertion);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      onClick={handleClick}
      disabled={busy || disabled}
      className={className}
    >
      {busy ? (
        <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Verifying…</>
      ) : (
        <><Fingerprint className="h-4 w-4 mr-2" /> {label}</>
      )}
    </Button>
  );
}
