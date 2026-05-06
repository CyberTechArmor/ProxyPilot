import { useState, useEffect, useRef, useCallback } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/api';
import { useToast, getNotificationHistory } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import {
  LayoutDashboard,
  User,
  Users,
  LogOut,
  Rocket,
  Server,
  Bell,
  Menu,
  TerminalSquare,
  KeyRound,
  Shield,
  ShieldAlert,
  Cable,
  BugPlay,
  LifeBuoy,
  HardDrive,
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

  // Notification panel state.
  //
  // Two sources merged into the bell dropdown:
  //   * Backend-posted notifications (durable across reload —
  //     /api/notifications).  Drive the unread badge.
  //   * In-session toast history (ephemeral, lost on reload —
  //     getNotificationHistory()).  Surfaced underneath the
  //     backend rows so an operator who just clicked Save still
  //     sees the toast in the dropdown for a few minutes.
  const [notifOpen, setNotifOpen] = useState(false);
  const [backendNotifs, setBackendNotifs] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [sessionNotifs, setSessionNotifs] = useState([]);
  const notifPanelRef = useRef(null);

  // Refresh backend notifications: on mount, every 30s, when the
  // panel opens.  30s is comfortable for daily-cron-driven entries
  // that don't need real-time delivery.
  const refreshBackendNotifs = useCallback(async () => {
    try {
      const r = await api.notificationsList();
      setBackendNotifs(r.notifications || []);
      setUnreadCount(r.unread_count || 0);
    } catch {
      // Tolerate auth-not-yet-loaded etc.; the next poll catches it.
    }
  }, []);

  useEffect(() => {
    refreshBackendNotifs();
    const id = setInterval(refreshBackendNotifs, 30_000);
    return () => clearInterval(id);
  }, [refreshBackendNotifs]);

  // Mirror in-session toasts into a separate list shown beneath
  // the backend rows.  Doesn't drive the unread badge — those
  // are confirmations the operator just dismissed by clicking
  // Save anyway.
  useEffect(() => {
    setSessionNotifs(getNotificationHistory());
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

  const openNotifications = async () => {
    const willOpen = !notifOpen;
    setNotifOpen(willOpen);
    if (willOpen) {
      // Mark-all-read on open so the badge clears immediately —
      // matches the existing UX where opening the panel is the
      // 'I saw it' signal.  Refresh after to pull the cleared
      // read_at values.
      try {
        await api.notificationsMarkAllRead();
      } catch { /* tolerated */ }
      await refreshBackendNotifs();
    }
  };

  const dismissNotification = async (id) => {
    try {
      await api.notificationsDismiss(id);
      await refreshBackendNotifs();
    } catch { /* tolerated; next poll catches up */ }
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

  // Version display only. The update-check / auto-update flow was
  // removed — operators update via `git pull && npm run build` on
  // the host (or whatever deploy mechanism they use). The sidebar
  // still shows the running version for identification.
  const [version, setVersion] = useState('');

  // CVE inbox unread count for the sidebar badge.
  const [cveUnread, setCveUnread] = useState(0);

  // Check admin status from user context and localStorage fallback
  const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';

  useEffect(() => {
    api.getVersion()
      .then(v => setVersion(v.version))
      .catch(e => console.error('Error fetching version:', e));
  }, []);

  // Poll the CVE inbox for unread count (entries with
  // state.operator_seen=false). Badge clears when the operator opens
  // an entry — the detail page hits api.markCveSeen on mount. 60s
  // poll is slow enough not to thrash the inbox dir scan, fast
  // enough for a fresh AUTO_PATCH-rollback page to surface promptly.
  useEffect(() => {
    if (!isAdmin) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await api.listCves();
        if (!cancelled) setCveUnread(data.unread || 0);
      } catch {
        // Admin without an inbox dir or transient error: leave the
        // last known count alone rather than blink to 0.
      }
    };
    poll();
    const id = setInterval(poll, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [isAdmin]);

  const navigation = [
    { name: 'Dashboard', href: '/', icon: LayoutDashboard },
    { name: 'Incus', href: '/incus', icon: Server, adminOnly: true },
    { name: 'Host Shell', href: '/admin/shell', icon: TerminalSquare, adminOnly: true },
    { name: 'SSH Access', href: '/ssh-access', icon: KeyRound, adminOnly: true },
    { name: 'Firewall', href: '/firewall', icon: Shield, adminOnly: true },
    { name: 'VPN', href: '/vpn', icon: Cable, adminOnly: true },
    { name: 'CVEs', href: '/cves', icon: BugPlay, adminOnly: true, badge: cveUnread },
    { name: 'Troubleshooting', href: '/troubleshooting', icon: LifeBuoy, adminOnly: true },
    { name: 'Housekeeping', href: '/housekeeping', icon: HardDrive, adminOnly: true },
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
                  <span className="flex-1">{item.name}</span>
                  {item.badge ? (
                    <span
                      className="ml-auto inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-orange-500 text-white text-xs font-semibold"
                      aria-label={`${item.badge} unread`}
                    >
                      {item.badge > 99 ? '99+' : item.badge}
                    </span>
                  ) : null}
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

                {/* Notification Panel — backend rows on top, then
                    in-session toasts.  Backend rows carry a level
                    + dismiss action; toasts are read-only and
                    auto-expire from the in-memory history. */}
                {notifOpen && (
                  <div className="fixed bottom-20 left-4 right-4 max-h-96 md:absolute md:bottom-full md:left-0 md:right-auto md:mb-2 md:w-96 bg-card border rounded-lg shadow-xl overflow-hidden z-50">
                    <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/50">
                      <h3 className="text-sm font-semibold">Notifications</h3>
                      <span className="text-xs text-muted-foreground">
                        {backendNotifs.length} alert{backendNotifs.length === 1 ? '' : 's'}
                        {sessionNotifs.length > 0 && ` · ${sessionNotifs.length} toast${sessionNotifs.length === 1 ? '' : 's'}`}
                      </span>
                    </div>
                    <div className="overflow-y-auto max-h-80">
                      {backendNotifs.length === 0 && sessionNotifs.length === 0 && (
                        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                          No notifications yet
                        </div>
                      )}
                      {backendNotifs.map((n) => (
                        <div
                          key={`b-${n.id}`}
                          className={cn(
                            'px-4 py-3 border-b last:border-0 hover:bg-muted/30 transition-colors',
                            n.level === 'error' && 'border-l-2 border-l-red-500',
                            n.level === 'warning' && 'border-l-2 border-l-amber-500',
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className={cn(
                                'text-sm font-medium truncate',
                                n.level === 'error' && 'text-red-500',
                                n.level === 'warning' && 'text-amber-600 dark:text-amber-400',
                              )}>
                                {n.title}
                              </p>
                              {n.body && (
                                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-3 break-words">
                                  {n.body}
                                </p>
                              )}
                              <p className="text-[10px] text-muted-foreground mt-1 font-mono">
                                {n.source}{n.seen_count > 1 ? ` · seen ${n.seen_count}×` : ''} · {formatNotifTime(n.last_seen_at)}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => dismissNotification(n.id)}
                              className="text-[10px] text-muted-foreground hover:text-foreground shrink-0 px-1 py-0.5 rounded hover:bg-muted"
                              title="Dismiss"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                      {sessionNotifs.length > 0 && backendNotifs.length > 0 && (
                        <div className="px-4 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/30 border-b">
                          Recent toasts
                        </div>
                      )}
                      {sessionNotifs.map((notif) => (
                        <div
                          key={`s-${notif.id}`}
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
                      ))}
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

      {/* Main content. Anchored to viewport height (h-screen) rather
          than min-h-screen so flex-1 children inside Outlet (HostShell
          terminal, LxcContainers terminal tab) get a definite parent
          height to compute against. With min-h-screen the flex chain
          falls back to content-sized heights and pages like Host Shell
          render their terminal short. Stacked-content pages scroll
          inside the inner div via overflow-y-auto. */}
      <main className="pl-0 md:pl-64 pt-14 md:pt-0 h-screen flex flex-col">
        <div className="p-4 md:p-8 flex-1 flex flex-col min-h-0 overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
