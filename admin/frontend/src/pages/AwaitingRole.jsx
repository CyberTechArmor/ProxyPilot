// Awaiting-role screen (ADR-011). A `pending` account is authenticated but has
// no role assigned yet, so it can reach nothing — this is the only surface it
// sees until a superadmin or admin grants it superadmin/admin/developer. This
// is the normal landing for a future LDAPS-provisioned user before onboarding.
//
// MOBILE_FIRST: single column, centred, renders clean at 360px; the sole action
// (Sign out) is a 44px touch target.

import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ShieldQuestion, LogOut } from 'lucide-react';

export default function AwaitingRole() {
  const { user, logout } = useAuth();

  return (
    <div className="flex flex-1 items-center justify-center py-12">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <ShieldQuestion className="h-6 w-6 text-muted-foreground" />
          </div>
          <CardTitle>Your account is awaiting a role</CardTitle>
          <CardDescription>
            You&apos;re signed in{user?.username ? ` as ${user.username}` : ''}, but an administrator
            hasn&apos;t granted your account access yet. Once a role is assigned, your workspace
            will appear here automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-3">
          <p className="text-center text-sm text-muted-foreground">
            Contact an administrator to be granted the <span className="font-medium">Admin</span> or{' '}
            <span className="font-medium">Developer</span> role.
          </p>
          <Button variant="outline" className="h-11 w-full sm:w-auto" onClick={logout}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
