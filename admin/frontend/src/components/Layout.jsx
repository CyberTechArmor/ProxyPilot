import { useState, useEffect, useRef } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { useToast, getNotificationHistory } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  LayoutDashboard,
  User,
  Users,
  LogOut,
  Rocket,
  Server,
  Download,
  X,
  Loader2,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  Bell,
  Menu,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export default function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const { toasts } = useToast();

  // Mobile sidebar drawer state
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Close the mobile sidebar whenever the route changes
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Notification panel state
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const lastSeenRef = useRef(0);
  const notifPanelRef = useRef(null);

  // Track new notifications
  useEffect(() => {
    const history = getNotificationHistory();
    setNotifications(history);
    const newCount = history.filter((n) => n.timestamp > lastSeenRef.current).length;
    setUnreadCount(newCount);
  }, [toasts]);

  // Close panel on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (notifPanelRef.current && !notifPanelRef.current.contains(e.target)) {
        setNotifOpen(false);
      }
    };
    if (notifOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [notifOpen]);

  const openNotifications = () => {
    setNotifOpen((prev) => !prev);
    lastSeenRef.current = new Date();
    setUnreadCount(0);
  };

  const formatNotifTime = (date) => {
    if (!date) return '';
    const d = new Date(date);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return d.toLocaleDateString();
  };

  // Version and update state
  const [version, setVersion] = useState('');
  const [updateInfo, setUpdateInfo] = useState(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [dismissedVersion, setDismissedVersion] = useState('');
  const [showUpdateBanner, setShowUpdateBanner] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateProgress, setUpdateProgress] = useState(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  // Check admin status from user context and localStorage fallback
  const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';

  // Fetch version and check for updates on mount
  useEffect(() => {
    fetchVersionInfo();
  }, []);

  // Poll for update progress when updating
  useEffect(() => {
    let interval;
    if (updating) {
      interval = setInterval(async () => {
        try {
          const progress = await api.getUpdateProgress();
          setUpdateProgress(progress);

          if (progress.status === 'success' || progress.status === 'error') {
            setUpdating(false);
          }
        } catch (e) {
          console.error('Error fetching update progress:', e);
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [updating]);

  const fetchVersionInfo = async () => {
    try {
      const versionData = await api.getVersion();
      setVersion(versionData.version);
      setUpdateDismissed(versionData.updateDismissed);
      setDismissedVersion(versionData.dismissedVersion);

      // Check for updates
      checkForUpdates(versionData.updateDismissed, versionData.dismissedVersion);
    } catch (e) {
      console.error('Error fetching version:', e);
    }
  };

  const checkForUpdates = async (dismissed = updateDismissed, dismissedVer = dismissedVersion) => {
    setCheckingUpdate(true);
    try {
      const update = await api.checkForUpdates();
      setUpdateInfo(update);

      // Show banner if update available and not dismissed for this version
      if (update.updateAvailable && (!dismissed || dismissedVer !== update.latestVersion)) {
        setShowUpdateBanner(true);
      } else {
        setShowUpdateBanner(false);
      }
    } catch (e) {
      console.error('Error checking for updates:', e);
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleDismiss = async () => {
    try {
      await api.dismissUpdate(updateInfo?.latestVersion);
      setShowUpdateBanner(false);
      setUpdateDismissed(true);
      setDismissedVersion(updateInfo?.latestVersion);
    } catch (e) {
      console.error('Error dismissing update:', e);
    }
  };

  const handleUpdate = async () => {
    setUpdateDialogOpen(true);
    setUpdating(true);
    setUpdateProgress({ status: 'running', message: 'Starting update...', logs: [] });

    try {
      await api.performUpdate();
    } catch (e) {
      console.error('Error starting update:', e);
      setUpdateProgress({ status: 'error', message: e.message, logs: [] });
      setUpdating(false);
    }
  };

  const [restarting, setRestarting] = useState(false);

  const handleCloseUpdateDialog = async () => {
    if (updateProgress?.status === 'success') {
      // Reset and refresh the page to load new version
      await api.resetUpdateStatus();
      window.location.reload();
    } else if (updateProgress?.status === 'error') {
      await api.resetUpdateStatus();
      setUpdateDialogOpen(false);
      setUpdateProgress(null);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await api.restartApplication();
      // Show message that restart is in progress
      setUpdateProgress({
        status: 'success',
        message: 'Restart initiated. The page will reload in a few seconds...',
        logs: ['Restart script executed', 'Waiting for application to restart...'],
      });
      // Wait a bit for the server to restart, then reload
      setTimeout(() => {
        window.location.reload();
      }, 5000);
    } catch (e) {
      console.error('Error restarting:', e);
      setRestarting(false);
    }
  };

  const navigation = [
    { name: 'Dashboard', href: '/', icon: LayoutDashboard },
    { name: 'Incus', href: '/incus', icon: Server, adminOnly: true },
    { name: 'Users', href: '/users', icon: Users, adminOnly: true },
    { name: 'Profile', href: '/profile', icon: User },
  ];

  const filteredNavigation = navigation.filter(item =>
    !item.adminOnly || isAdmin
  );

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile top bar (hidden on md+) */}
      <header className="fixed top-0 inset-x-0 z-40 flex h-14 items-center gap-2 border-b bg-card px-4 md:hidden">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open navigation menu"
          className="h-11 w-11"
        >
          <Menu className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-2">
          <Rocket className="h-6 w-6 text-primary" />
          <span className="text-lg font-bold">ProxyPilot</span>
        </div>
      </header>

      {/* Update Banner */}
      {showUpdateBanner && updateInfo?.updateAvailable && (
        <div className="fixed top-14 md:top-0 left-0 md:left-64 right-0 z-30 bg-primary text-primary-foreground px-4 py-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Download className="h-4 w-4 shrink-0" />
            <span className="text-sm">
              Update available: v{updateInfo.latestVersion} (current: v{version})
              {' '}<span className="opacity-75 hidden sm:inline">- Update via command line: git pull && npm run build</span>
            </span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleDismiss}
            className="text-primary-foreground hover:bg-primary/80 shrink-0"
            title="Dismiss"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Mobile sidebar backdrop (click to close) */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 bg-card border-r transform transition-transform duration-200 ease-out",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
          "md:translate-x-0"
        )}
      >
        <div className="flex flex-col h-full">
          {/* Logo and Version */}
          <div className="flex flex-col px-6 py-4 border-b">
            <div className="flex items-center gap-2">
              <Rocket className="h-8 w-8 text-primary" />
              <span className="text-xl font-bold">ProxyPilot</span>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-muted-foreground">
                v{version || '...'}
              </span>
              {updateInfo?.updateAvailable && !showUpdateBanner && (
                <span className="text-xs text-primary cursor-pointer hover:underline" onClick={() => setShowUpdateBanner(true)}>
                  (update available)
                </span>
              )}
              {checkingUpdate && (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              )}
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex-1 px-4 py-4 space-y-1">
            {filteredNavigation.map((item) => {
              const isActive = location.pathname === item.href;
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  )}
                >
                  <item.icon className="h-5 w-5" />
                  {item.name}
                </Link>
              );
            })}
          </nav>

          {/* User section */}
          <div className="px-4 py-4 border-t">
            <div className="flex items-center gap-3 px-3 py-2">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{user?.username}</p>
                <p className="text-xs text-muted-foreground">{isAdmin ? 'Administrator' : 'User'}</p>
              </div>
              <div className="relative" ref={notifPanelRef}>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={openNotifications}
                  title="Notifications"
                  className="relative h-11 w-11 md:h-10 md:w-10"
                >
                  <Bell className="h-5 w-5" />
                  {unreadCount > 0 && (
                    <span className="absolute -top-1 -right-1 h-4 min-w-[16px] px-1 rounded-full bg-red-500 text-[10px] font-bold text-white flex items-center justify-center">
                      {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                  )}
                </Button>

                {/* Notification Panel */}
                {notifOpen && (
                  <div className="fixed bottom-20 left-4 right-4 max-h-96 md:absolute md:bottom-full md:left-0 md:right-auto md:mb-2 md:w-80 bg-card border rounded-lg shadow-xl overflow-hidden z-50">
                    <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/50">
                      <h3 className="text-sm font-semibold">Notifications</h3>
                      <span className="text-xs text-muted-foreground">{notifications.length} total</span>
                    </div>
                    <div className="overflow-y-auto max-h-80">
                      {notifications.length === 0 ? (
                        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                          No notifications yet
                        </div>
                      ) : (
                        notifications.map((notif) => (
                          <div
                            key={notif.id}
                            className={cn(
                              'px-4 py-3 border-b last:border-0 hover:bg-muted/30 transition-colors',
                              notif.variant === 'destructive' && 'border-l-2 border-l-red-500'
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <p className={cn(
                                  'text-sm font-medium truncate',
                                  notif.variant === 'destructive' && 'text-red-500'
                                )}>
                                  {notif.title}
                                </p>
                                {notif.description && (
                                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                                    {notif.description}
                                  </p>
                                )}
                              </div>
                              <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
                                {formatNotifTime(notif.timestamp)}
                              </span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={logout}
                title="Logout"
                className="h-11 w-11 md:h-10 md:w-10"
              >
                <LogOut className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main
        className={cn(
          "pl-0 md:pl-64 pt-14 md:pt-0",
          showUpdateBanner && updateInfo?.updateAvailable && "md:pt-10"
        )}
      >
        <div className="p-4 md:p-8">
          <Outlet />
        </div>
      </main>

      {/* Update Progress Dialog */}
      <Dialog open={updateDialogOpen} onOpenChange={() => {}}>
        <DialogContent className="sm:max-w-md" onPointerDownOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {updateProgress?.status === 'running' && (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  Updating ProxyPilot
                </>
              )}
              {updateProgress?.status === 'success' && (
                <>
                  <CheckCircle className="h-5 w-5 text-green-500" />
                  Update Complete
                </>
              )}
              {updateProgress?.status === 'error' && (
                <>
                  <AlertCircle className="h-5 w-5 text-red-500" />
                  Update Failed
                </>
              )}
            </DialogTitle>
            <DialogDescription>
              {updateProgress?.message}
            </DialogDescription>
          </DialogHeader>

          {/* Progress logs */}
          {updateProgress?.logs && updateProgress.logs.length > 0 && (
            <div className="bg-muted p-3 rounded-md max-h-48 overflow-auto">
              <pre className="text-xs font-mono whitespace-pre-wrap">
                {updateProgress.logs.join('\n')}
              </pre>
            </div>
          )}

          {updateProgress?.status === 'running' && (
            <div className="flex justify-center py-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Please wait, do not close this window...
              </div>
            </div>
          )}

          <DialogFooter className="flex-col sm:flex-row gap-2">
            {updateProgress?.status === 'success' && !restarting && (
              <>
                <Button variant="outline" onClick={handleCloseUpdateDialog}>
                  Reload Page Only
                </Button>
                <Button onClick={handleRestart}>
                  Restart Application
                </Button>
              </>
            )}
            {restarting && (
              <Button disabled>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Restarting...
              </Button>
            )}
            {updateProgress?.status === 'error' && (
              <Button variant="outline" onClick={handleCloseUpdateDialog}>
                Close
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
