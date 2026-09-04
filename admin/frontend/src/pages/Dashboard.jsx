import { useState, useEffect, useMemo, useCallback, useRef, Fragment } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import LxcContainers from './LxcContainers';
import PasskeyConfirmButton from '@/components/PasskeyConfirmButton';
import ServiceL4AndPorts from '@/components/ServiceL4AndPorts';
import ServiceCertMounts from '@/components/ServiceCertMounts';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import { markdown } from '@codemirror/lang-markdown';
import { xml } from '@codemirror/lang-xml';
import { oneDark } from '@codemirror/theme-one-dark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast, getNotificationHistory } from '@/hooks/use-toast';
import {
  Plus,
  Trash2,
  Globe,
  FolderOpen,
  Container,
  Loader2,
  Shield,
  RefreshCw,
  FileText,
  File,
  Folder,
  Download,
  Upload,
  Save,
  X,
  ChevronRight,
  ChevronDown,
  FilePlus,
  Check,
  Server,
  Search,
  Star,
  SortAsc,
  Filter,
  History,
  RotateCcw,
  Maximize2,
  Minimize2,
  Code,
  MessageSquare,
  Edit3,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Info,
  RefreshCcw,
  Terminal,
  Play,
  Square,
  RotateCw,
  Radar,
  Import,
  Box,
  Boxes,
  LayoutGrid,
  List,
  Package,
  Rocket,
  FolderTree,
  Eye,
  FolderPlus,
  GripVertical,
  Cpu,
  HardDrive,
  MemoryStick,
  Activity,
  Clock,
  Settings,
  Bell,
  FileArchive,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import InteractiveTerminal from '@/components/InteractiveTerminal';
import ZipUploadDialog from '@/components/ZipUploadDialog';

// Language detection based on file extension
const getLanguageFromFile = (filename) => {
  const ext = filename.split('.').pop()?.toLowerCase();
  const langMap = {
    js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    html: 'html', htm: 'html', css: 'css', scss: 'css', sass: 'css',
    json: 'json', yml: 'yaml', yaml: 'yaml', xml: 'xml',
    md: 'markdown', py: 'python', rb: 'ruby', php: 'php',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    sql: 'sql', go: 'go', rs: 'rust', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
    dockerfile: 'dockerfile', nginx: 'nginx', conf: 'nginx',
  };
  return langMap[ext] || 'plaintext';
};

// Default docker-compose template
const DEFAULT_COMPOSE_CONTENT = "version: '3.8'\nservices:\n  app:\n    image: nginx:alpine\n    ports:\n      - \"8080:80\"\n    restart: unless-stopped\n";

// Phase 2b H.3: per-row React keys for the wizard routes builder. Not a
// crypto-strong UID — just needs to be unique within a single wizard
// session so adding/removing rows keeps input focus + does not confuse
// React's reconciler into reusing a stale input node.
let _pp2bRouteUidCounter = 0;
function pp2bRouteUid() {
  _pp2bRouteUidCounter += 1;
  return `wiz-route-${Date.now().toString(36)}-${_pp2bRouteUidCounter}`;
}

// Syntax highlighting colors by language
const getLanguageColor = (lang) => {
  const colors = {
    javascript: '#f7df1e', typescript: '#3178c6', html: '#e34f26',
    css: '#264de4', json: '#292929', yaml: '#cb171e',
    python: '#3776ab', php: '#777bb4', ruby: '#cc342d',
    bash: '#4eaa25', sql: '#e38c00', go: '#00add8',
    rust: '#dea584', java: '#007396', dockerfile: '#2496ed',
  };
  return colors[lang] || '#6b7280';
};

// Get CodeMirror language extension
const getLanguageExtension = (lang) => {
  switch (lang) {
    case 'javascript':
    case 'typescript':
      return javascript({ jsx: true, typescript: lang === 'typescript' });
    case 'html':
      return html();
    case 'css':
      return css();
    case 'json':
      return json();
    case 'python':
      return python();
    case 'yaml':
      return yaml();
    case 'markdown':
      return markdown();
    case 'xml':
    case 'nginx':
    case 'dockerfile':
      return xml();
    default:
      return [];
  }
};

export default function Dashboard() {
  const { user } = useAuth();
  const storedUser = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user?.role === 'admin' || storedUser?.role === 'admin';

  const [services, setServices] = useState([]);
  // Route drift: the route table vs. what the edge is actually serving.
  // Reporting only — the banner points at the existing "Regenerate All" action.
  const [routeDrift, setRouteDrift] = useState(null);
  const [loading, setLoading] = useState(true);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [removeCertDialogOpen, setRemoveCertDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [serviceToDelete, setServiceToDelete] = useState(null);
  const [serviceToRemoveCert, setServiceToRemoveCert] = useState(null);
  const [selectedService, setSelectedService] = useState(null);
  const [totpCode, setTotpCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Service settings dialog state
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [settingsService, setSettingsService] = useState(null);
  const [settingsForm, setSettingsForm] = useState({
    target: '127.0.0.1',
    port: '',
    websocketEnabled: false,
    forceHttps: true,
    maxUploadSize: '1G',
    sslEnabled: true,
    rootDir: '',
    dataDir: '',
  });
  const [settingsTab, setSettingsTab] = useState('settings'); // 'settings', 'history', or 'caddy'
  const [savingSettings, setSavingSettings] = useState(false);
  // Phase 2b I.1: Routes card state for the settings dialog's Settings
  // tab. `settingsRoutes` mirrors the service's routes as loaded from
  // `api.getServiceRoutes`. `editingRouteId` is either a route id (edit
  // mode), the sentinel string `'new'` (add mode), or `null` (no form).
  // `editingRouteDraft` holds the inline form's current values.
  const [settingsRoutes, setSettingsRoutes] = useState([]);
  const [settingsRoutesLoading, setSettingsRoutesLoading] = useState(false);
  const [editingRouteId, setEditingRouteId] = useState(null);
  const [editingRouteDraft, setEditingRouteDraft] = useState(null);
  const [savingRoute, setSavingRoute] = useState(false);
  // Phase 2b I.2: LXC IP refresh state for the settings dialog.
  const [refreshingLxcIp, setRefreshingLxcIp] = useState(false);
  const [configVersions, setConfigVersions] = useState([]);
  const [caddyConfig, setCaddyConfig] = useState('');
  const [caddyConfigOriginal, setCaddyConfigOriginal] = useState('');
  const [loadingCaddyConfig, setLoadingCaddyConfig] = useState(false);
  const [savingCaddyConfig, setSavingCaddyConfig] = useState(false);
  const [loadingConfigVersions, setLoadingConfigVersions] = useState(false);
  const [revertingVersion, setRevertingVersion] = useState(null);

  // Search/Filter/Sort state
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [sortBy, setSortBy] = useState('favorite');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);

  // Mobile-only collapse of the folder sidebar (closed by default at <md)
  const [mobileFoldersOpen, setMobileFoldersOpen] = useState(false);

  // Full screen editor state
  const [editorOpen, setEditorOpen] = useState(false);
  const [zipUploadOpen, setZipUploadOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Mobile-only file tree drawer toggle in the file editor
  const [mobileFileTreeOpen, setMobileFileTreeOpen] = useState(false);

  // Add service wizard state
  const [wizardStep, setWizardStep] = useState(0);
  // Phase 2b H.2: LXC container picker state shared between the runtime
  // sub-step and the container dropdown it renders. Populated on demand
  // via api.getLxcContainersWithIp() when the operator clicks the LXC
  // runtime tile so we do not pay the Incus round-trip on every wizard
  // open. Cleared alongside the rest of the wizard state in resetForm().
  const [lxcWizardContainers, setLxcWizardContainers] = useState([]);
  const [lxcWizardLoading, setLxcWizardLoading] = useState(false);
  const [lxcWizardError, setLxcWizardError] = useState('');
  const [formData, setFormData] = useState({
    name: '',
    // Phase 2b H.3: the primary source of truth for per-route fields is
    // now the `routes` array. Each entry is
    // `{id, domain, pathPrefix, targetPort, sslEnabled}`. The legacy
    // top-level mirror fields (domain, pathPrefix, port, sslEnabled)
    // stay in sync with routes[0] so the Phase 2 flat POST payload in
    // `handleAddService` keeps validating until H.6 swaps in the
    // nested-routes payload. `pp2bRouteUid()` generates stable row keys
    // so React does not lose focus when the routes list mutates.
    routes: [
      { id: pp2bRouteUid(), domain: '', pathPrefix: '/', targetPort: '', sslEnabled: true },
    ],
    rootDir: '',
    domain: '',
    pathPrefix: '/',
    // Phase 2b H.1: the Add Service wizard now branches on `kind`
    // (static_site | container_service) at Step 0. `runtime` is the
    // container_service sub-choice filled in at H.2 (Step 1 picker).
    // `type` is the legacy Phase 2 field kept in sync for backend D.2
    // which still accepts a flat payload — H.6 will sort out the map.
    kind: '',
    runtime: null,
    targetIp: '',
    lxcContainerName: '',
    type: '',
    target: '127.0.0.1',
    port: '',
    containerName: '',
    sslEnabled: true,
    forceHttps: true,
    websocketEnabled: true,
    maxUploadSize: '1G',
    obtainCertificate: true,
  });

  // File management state
  const [files, setFiles] = useState([]);
  const [expandedDirs, setExpandedDirs] = useState({});
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [newFileName, setNewFileName] = useState('');
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState('plaintext');

  // Version control state
  const [versions, setVersions] = useState([]);
  const [showVersions, setShowVersions] = useState(false);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [editingNotes, setEditingNotes] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [saveNotes, setSaveNotes] = useState('');

  // Export/Import state
  const [exportServiceIds, setExportServiceIds] = useState([]);
  const [exportIncludeFiles, setExportIncludeFiles] = useState(true);
  const [importData, setImportData] = useState('');
  const [importOverwrite, setImportOverwrite] = useState(false);

  // Terminal state
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalCommand, setTerminalCommand] = useState('');
  const [terminalOutput, setTerminalOutput] = useState([]);
  const [terminalRunning, setTerminalRunning] = useState(false);
  const terminalAbortRef = useRef(null);
  const [containers, setContainers] = useState([]);
  const [systemInfo, setSystemInfo] = useState(null);
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);
  const [terminalCwd, setTerminalCwd] = useState('/');
  // Cwd handed off to the live PTY. Distinct from terminalCwd (file
  // browser cwd) so navigating folders doesn't tear down a running
  // session — only an explicit "Open terminal here" copies the file
  // browser path into terminalInitialCwd, which forces a reconnect.
  const [terminalInitialCwd, setTerminalInitialCwd] = useState('');
  const terminalOutputRef = useCallback(node => {
    if (node) node.scrollTop = node.scrollHeight;
  }, [terminalOutput]);
  const terminalInputRef = useRef(null);

  // Kill switch state
  const [killSwitchDialogOpen, setKillSwitchDialogOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [securingSystem, setSecuringSystem] = useState(false);

  // Discovery state
  const [discoverDialogOpen, setDiscoverDialogOpen] = useState(false);
  const [discoveredSites, setDiscoveredSites] = useState([]);
  const [discoveringCaddy, setDiscoveringCaddy] = useState(false);
  const [importingSite, setImportingSite] = useState(null);

  // Remove site dialog state
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [siteToRemove, setSiteToRemove] = useState(null);
  const [removeOptions, setRemoveOptions] = useState({ files: true, docker: false, cert: false });
  const [removingConfirmation, setRemovingConfirmation] = useState('');
  const [removingSite, setRemovingSite] = useState(false);

  // Docker Compose services state
  const [composeServices, setComposeServices] = useState([]);

  // Nano editor state (for terminal intercept)
  const [nanoEditorOpen, setNanoEditorOpen] = useState(false);
  const [nanoFilePath, setNanoFilePath] = useState('');
  const [nanoFileContent, setNanoFileContent] = useState('');
  const [nanoSaving, setNanoSaving] = useState(false);
  const [nanoVersions, setNanoVersions] = useState([]);
  const [nanoShowVersions, setNanoShowVersions] = useState(false);

  // Dashboard view state
  const [viewMode, setViewMode] = useState('grid'); // 'grid' or 'list'

  // Docker Compose project expansion state
  const [expandedProjects, setExpandedProjects] = useState({});

  // Terminal improvements
  const [commandHistory, setCommandHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [tabSuggestions, setTabSuggestions] = useState([]);
  const [showTabSuggestions, setShowTabSuggestions] = useState(false);
  const [terminalFiles, setTerminalFiles] = useState([]);
  const [terminalDirs, setTerminalDirs] = useState([]);
  const [expandedTerminalDirs, setExpandedTerminalDirs] = useState({});
  const [loadingTerminalFiles, setLoadingTerminalFiles] = useState(false);

  // One-Click Install state
  const [oneClickDialogOpen, setOneClickDialogOpen] = useState(false);
  const [oneClickService, setOneClickService] = useState(null);
  const [oneClickInstalling, setOneClickInstalling] = useState(false);
  const [oneClickForm, setOneClickForm] = useState({
    siteName: '',
    domain: '',
    wordpressPort: '7000',
    dbPort: '7001',
  });

  // Terminal tab state: 'terminal' | 'editor' (+ 'files' on mobile only).
  // On desktop both file browser and terminal/editor show side-by-side and this
  // value only picks between Terminal and Editor in the right-hand tab strip.
  // On mobile the dialog becomes single-pane and this value also drives which
  // of the three (Files, Terminal, Editor) is visible via a bottom tab bar.
  const [terminalActiveTab, setTerminalActiveTab] = useState('terminal');
  const [editorFilePath, setEditorFilePath] = useState('');
  const [editorContent, setEditorContent] = useState('');
  const [editorOriginalContent, setEditorOriginalContent] = useState('');
  const [editorVersions, setEditorVersions] = useState([]);
  const [editorShowVersions, setEditorShowVersions] = useState(false);
  const [editorLoadingVersions, setEditorLoadingVersions] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);

  // Docker Compose action state
  const [composeActionLoading, setComposeActionLoading] = useState({});
  const [destroyDialogOpen, setDestroyDialogOpen] = useState(false);
  const [projectToDestroy, setProjectToDestroy] = useState(null);
  const [destroyTotpCode, setDestroyTotpCode] = useState('');
  const [destroyOptions, setDestroyOptions] = useState({
    removeVolumes: false,
    removeImages: false,
    removeOrphans: true,
    prune: false,
  });
  const [destroyingProject, setDestroyingProject] = useState(false);

  // Docker Compose create state
  const [composeCreateOpen, setComposeCreateOpen] = useState(false);
  const [composeCreateForm, setComposeCreateForm] = useState({
    serviceName: '',
    composeContent: DEFAULT_COMPOSE_CONTENT,
    envVars: [], // Array of { key: '', value: '' }
  });
  const [composeCreating, setComposeCreating] = useState(false);

  // Helper functions for .env management
  const generateSecureValue = (placeholder) => {
    if (placeholder === '{password}') {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
      return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    }
    if (placeholder === '{hex}') {
      return Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    }
    if (placeholder === '{jwt}') {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      return Array.from({ length: 64 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    }
    return placeholder;
  };

  const processEnvValue = (value) => {
    // Replace placeholders with generated values
    return value
      .replace(/\{password\}/g, () => generateSecureValue('{password}'))
      .replace(/\{hex\}/g, () => generateSecureValue('{hex}'))
      .replace(/\{jwt\}/g, () => generateSecureValue('{jwt}'));
  };

  const addEnvVar = () => {
    setComposeCreateForm(prev => ({
      ...prev,
      envVars: [...prev.envVars, { key: '', value: '' }]
    }));
  };

  const removeEnvVar = (index) => {
    setComposeCreateForm(prev => ({
      ...prev,
      envVars: prev.envVars.filter((_, i) => i !== index)
    }));
  };

  const updateEnvVar = (index, field, value) => {
    setComposeCreateForm(prev => ({
      ...prev,
      envVars: prev.envVars.map((env, i) => i === index ? { ...env, [field]: value } : env)
    }));
  };

  const importEnvFile = (content) => {
    const lines = content.split('\n');
    const envVars = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex).trim();
        let value = trimmed.substring(eqIndex + 1).trim();
        // Remove surrounding quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        envVars.push({ key, value });
      }
    }
    setComposeCreateForm(prev => ({ ...prev, envVars }));
  };

  // Compose search/filter state
  const [composeSearchQuery, setComposeSearchQuery] = useState('');
  const [composeStatusFilter, setComposeStatusFilter] = useState('all'); // 'all', 'running', 'stopped'
  const [composeSortBy, setComposeSortBy] = useState('name'); // 'name', 'containers', 'status'

  // Service folder state
  const [serviceFolders, setServiceFolders] = useState(() => {
    const saved = localStorage.getItem('serviceFolders');
    return saved ? JSON.parse(saved) : {};
  });
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [selectedServiceForFolder, setSelectedServiceForFolder] = useState(null);
  const [expandedFolders, setExpandedFolders] = useState({});
  const [selectedFolderFilter, setSelectedFolderFilter] = useState(null); // null = all, '' = unfoldered, 'path' = specific folder
  const [selectedParentFolder, setSelectedParentFolder] = useState(null);
  const [draggedFolder, setDraggedFolder] = useState(null);
  const [draggedService, setDraggedService] = useState(null);
  const [dragOverFolder, setDragOverFolder] = useState(null);
  const [folderDropPosition, setFolderDropPosition] = useState(null); // { folderPath, position: 'before' | 'after' }

  // Dashboard view state — Compose tab is hidden; if the operator's
  // saved default is 'compose' (from before the hide), fall back to
  // resources so they don't land on an empty tab bar.
  const [dashboardTab, setDashboardTab] = useState(() => {
    const saved = localStorage.getItem('dashboardDefaultTab') || 'resources';
    return saved === 'compose' ? 'resources' : saved;
  });

  // System stats state for resource utilization
  const [systemStats, setSystemStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const statsIntervalRef = useRef(null);

  const { toast } = useToast();

  // Get folder for a service
  const getServiceFolder = (serviceId) => {
    for (const [path, folder] of Object.entries(serviceFolders)) {
      if (folder.services?.includes(serviceId)) {
        return path;
      }
    }
    return null;
  };

  // Filtered and sorted services
  const filteredServices = useMemo(() => {
    let result = [...services];

    // Folder filter
    if (selectedFolderFilter !== null) {
      if (selectedFolderFilter === '') {
        // Show unfoldered services
        const folderedServiceIds = Object.values(serviceFolders).flatMap(f => f.services || []);
        result = result.filter(s => !folderedServiceIds.includes(s.id));
      } else {
        // Show services in specific folder
        const folder = serviceFolders[selectedFolderFilter];
        if (folder?.services) {
          result = result.filter(s => folder.services.includes(s.id));
        } else {
          result = [];
        }
      }
    }

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(s =>
        s.name.toLowerCase().includes(query) ||
        s.domain.toLowerCase().includes(query)
      );
    }

    // Type filter
    if (filterType !== 'all') {
      result = result.filter(s => s.type === filterType);
    }

    // Favorites filter
    if (showFavoritesOnly) {
      result = result.filter(s => s.isFavorite);
    }

    // Sort
    result.sort((a, b) => {
      // Always show favorites first if sorting by favorite
      if (sortBy === 'favorite') {
        if (a.isFavorite && !b.isFavorite) return -1;
        if (!a.isFavorite && b.isFavorite) return 1;
      }

      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'domain':
          return a.domain.localeCompare(b.domain);
        case 'type':
          return a.type.localeCompare(b.type);
        case 'newest':
          return new Date(b.createdAt) - new Date(a.createdAt);
        case 'oldest':
          return new Date(a.createdAt) - new Date(b.createdAt);
        default:
          return 0;
      }
    });

    return result;
  }, [services, searchQuery, filterType, sortBy, showFavoritesOnly, selectedFolderFilter, serviceFolders]);

  // Phase 2b H.4: the wizard now renders one banner per in-progress
  // route, so the memo returns a `Map<domain, prefixList>` keyed on
  // every route across every service instead of filtering by a single
  // form-scoped domain. Services pre-Phase 2b still expose a legacy
  // top-level `domain`/`pathPrefix` fallback alongside the nested
  // `routes` array, so the flattener falls back on the legacy pair
  // when `routes` is missing — that keeps old installs rendering
  // during the phase-2b rollout. The lowercase-normalized domain is
  // the map key; prefix strings are stored as-given (normalization
  // for the collision check lives in H.5's handleAddService).
  const existingPrefixesByDomain = useMemo(() => {
    const map = new Map();
    const push = (rawDomain, rawPrefix) => {
      const d = (rawDomain || '').toLowerCase().trim();
      if (!d) return;
      const prefix = rawPrefix || '/';
      const list = map.get(d) || [];
      list.push(prefix);
      map.set(d, list);
    };
    for (const svc of services) {
      if (Array.isArray(svc.routes) && svc.routes.length > 0) {
        for (const r of svc.routes) {
          push(r.domain, r.pathPrefix);
        }
      } else if (svc.domain) {
        // Fallback: legacy Phase 2 shape with a single top-level route.
        push(svc.domain, svc.pathPrefix);
      }
    }
    return map;
  }, [services]);

  // Phase 2b H.4: backward-compat shim for any code paths still
  // reading the single-domain list (notably the H.5-pending client
  // collision guard in handleAddService). Returns the flattened
  // prefix list for the wizard's primary-row domain. Replaced in H.5.
  const existingPrefixesForDomain = useMemo(() => {
    const d = (formData.domain || '').toLowerCase().trim();
    if (!d) return [];
    return existingPrefixesByDomain.get(d) || [];
  }, [existingPrefixesByDomain, formData.domain]);

  // Group compose services by project with search/filter/sort
  const groupedComposeProjects = useMemo(() => {
    const groups = {};
    composeServices.forEach(svc => {
      const project = svc.projectName || 'standalone';
      if (!groups[project]) {
        groups[project] = {
          projectName: project,
          services: [],
          isRunning: false,
        };
      }
      groups[project].services.push(svc);
      if (svc.isRunning) groups[project].isRunning = true;
    });

    let result = Object.values(groups);

    // Apply search filter
    if (composeSearchQuery) {
      const query = composeSearchQuery.toLowerCase();
      result = result.filter(p =>
        p.projectName.toLowerCase().includes(query) ||
        p.services.some(s => s.name?.toLowerCase().includes(query) || s.image?.toLowerCase().includes(query))
      );
    }

    // Apply status filter
    if (composeStatusFilter === 'running') {
      result = result.filter(p => p.isRunning);
    } else if (composeStatusFilter === 'stopped') {
      result = result.filter(p => !p.isRunning);
    }

    // Apply sorting
    result.sort((a, b) => {
      switch (composeSortBy) {
        case 'name':
          return a.projectName.localeCompare(b.projectName);
        case 'containers':
          return b.services.length - a.services.length;
        case 'status':
          return (b.isRunning ? 1 : 0) - (a.isRunning ? 1 : 0);
        default:
          return 0;
      }
    });

    return result;
  }, [composeServices, composeSearchQuery, composeStatusFilter, composeSortBy]);

  const fetchServices = async () => {
    try {
      const { services } = await api.getServices();
      setServices(services);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setLoading(false);
    }
  };

  const fetchRouteDrift = async () => {
    try {
      setRouteDrift(await api.getRouteDrift());
    } catch (error) {
      // Advisory: a failed drift check must never block the services list.
      console.error('Failed to fetch route drift:', error);
    }
  };

  const fetchComposeServices = async () => {
    try {
      const { services: compose } = await api.getDockerComposeServices();
      setComposeServices(compose || []);
    } catch (error) {
      console.error('Failed to fetch compose services:', error);
    }
  };

  useEffect(() => {
    fetchServices();
    fetchComposeServices();
    fetchRouteDrift();
  }, []);

  // Fetch system stats for resource utilization
  const fetchSystemStats = async () => {
    try {
      const result = await api.getSystemStats();
      // Result is the stats object directly (not wrapped in { success, stats })
      if (result && result.cpu) {
        setSystemStats(result);
      }
    } catch (error) {
      // Don't log rate limit errors to console spam
      if (!error.message?.includes('429') && !error.message?.includes('Too many')) {
        console.error('Failed to fetch system stats:', error);
      }
    }
  };

  // Effect to fetch stats on interval when resources tab is active
  useEffect(() => {
    if (dashboardTab === 'resources') {
      setStatsLoading(true);
      fetchSystemStats().finally(() => setStatsLoading(false));

      // Refresh every 30 seconds to prevent resource exhaustion
      statsIntervalRef.current = setInterval(fetchSystemStats, 30000);

      return () => {
        if (statsIntervalRef.current) {
          clearInterval(statsIntervalRef.current);
        }
      };
    }
  }, [dashboardTab]);

  // Keyboard shortcut handler for editor (Ctrl+S)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        // Only handle if terminal is open and editor tab is active with a file
        if (terminalOpen && terminalActiveTab === 'editor' && editorFilePath && editorContent !== editorOriginalContent) {
          e.preventDefault();
          handleEditorSave();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [terminalOpen, terminalActiveTab, editorFilePath, editorContent, editorOriginalContent]);

  // Discovery functions
  const discoverSites = async () => {
    setDiscoveringCaddy(true);
    try {
      const { sites } = await api.discoverCaddySites();
      setDiscoveredSites(sites || []);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to discover sites: ' + error.message,
      });
    } finally {
      setDiscoveringCaddy(false);
    }
  };

  const importSite = async (site) => {
    setImportingSite(site.domain);
    try {
      await api.importDiscoveredSite(site);
      toast({
        title: 'Success',
        description: `Imported ${site.name} successfully`,
      });
      setDiscoveredSites(prev => prev.filter(s => s.domain !== site.domain));
      fetchServices();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to import: ' + error.message,
      });
    } finally {
      setImportingSite(null);
    }
  };

  const openRemoveDialog = (site) => {
    setSiteToRemove(site);
    setRemoveOptions({
      files: true,
      docker: site.type === 'docker',
      cert: site.sslEnabled || false,
    });
    setRemovingConfirmation('');
    setRemoveDialogOpen(true);
  };

  const handleRemoveSite = async () => {
    if (!siteToRemove || removingConfirmation !== siteToRemove.domain) return;

    setRemovingSite(true);
    try {
      const commands = [];

      // Remove Caddy config files
      if (removeOptions.files) {
        commands.push(`rm -f /etc/caddy/sites/${siteToRemove.domain}`);
        if (siteToRemove.rootDir && siteToRemove.type === 'static') {
          commands.push(`rm -rf "${siteToRemove.rootDir}"`);
        }
      }

      // Remove Docker containers, images, and volumes
      if (removeOptions.docker && siteToRemove.composePath) {
        commands.push(`cd "${siteToRemove.composePath}" && docker compose down -v --rmi local 2>/dev/null || true`);
        commands.push(`rm -rf "${siteToRemove.composePath}"`);
      }

      // Execute removal commands
      for (const cmd of commands) {
        await api.executeCommand(cmd, '/');
      }

      // Reload Caddy
      await api.executeCommand('caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || true', '/');

      toast({
        title: 'Success',
        description: `Removed ${siteToRemove.name} successfully`,
      });

      setRemoveDialogOpen(false);
      setSiteToRemove(null);
      discoverSites(); // Refresh the discover list
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to remove: ' + error.message,
      });
    } finally {
      setRemovingSite(false);
    }
  };

  const handleTypeSelect = (type) => {
    setFormData({ ...formData, type });
    setWizardStep(1);
  };

  // Phase 2b H.2: pick the container runtime (lxc or docker) inside
  // the Step 1 sub-step that only shows for kind='container_service'.
  // For LXC we eagerly fetch the compact container-with-ip listing so
  // the dropdown can render immediately; failures surface inline via
  // lxcWizardError rather than a toast (the dialog is the only focus).
  const handleRuntimeSelect = async (runtime) => {
    setFormData((f) => ({
      ...f,
      runtime,
      // Both LXC and Docker runtimes reverse-proxy to a container IP,
      // and D.2's Phase 2 schema only accepts `type: 'static'|'docker'`.
      // Map both container runtimes onto the legacy 'docker' type so the
      // existing POST payload keeps validating until H.6 swaps in the
      // full nested-routes payload.
      type: 'docker',
      // Reset any half-filled state from a previous runtime pick.
      lxcContainerName: '',
      targetIp: runtime === 'docker' ? (f.target || '127.0.0.1') : '',
      containerName: runtime === 'docker' ? f.containerName : '',
    }));
    if (runtime === 'lxc') {
      setLxcWizardLoading(true);
      setLxcWizardError('');
      try {
        const { containers } = await api.getLxcContainersWithIp();
        setLxcWizardContainers(containers || []);
      } catch (err) {
        setLxcWizardError(err.message || 'Failed to load LXC containers');
        setLxcWizardContainers([]);
      } finally {
        setLxcWizardLoading(false);
      }
    }
  };

  // Phase 2b H.2: the operator picked a specific LXC container from the
  // dropdown. Stamp the (name, ipv4) pair onto formData and expose it
  // read-only downstream — the wizard uses the cached IP, not a live
  // re-resolution (see the spec's "LXC IP refresh" note + E.2).
  const handleLxcContainerSelect = (containerName) => {
    const container = lxcWizardContainers.find((c) => c.name === containerName);
    if (!container) return;
    const ipv4 = container.ipv4 || '';
    setFormData((f) => ({
      ...f,
      lxcContainerName: container.name,
      targetIp: ipv4,
      // Keep legacy `target` in sync so the pre-H.6 POST payload still
      // carries the right IP — D.2 reads `target` to populate
      // services.target_ip.
      target: ipv4 || f.target,
      containerName: container.name,
    }));
  };

  // Phase 2b H.3: append a fresh empty route row to the wizard routes
  // array. The row is initialized with the conventional defaults
  // (pathPrefix='/', sslEnabled=true) and a stable React key.
  const addWizardRoute = () => {
    setFormData((f) => ({
      ...f,
      routes: [
        ...f.routes,
        { id: pp2bRouteUid(), domain: '', pathPrefix: '/', targetPort: '', sslEnabled: true },
      ],
    }));
  };

  // Phase 2b H.3: remove the route at index `i`. No-ops when only one
  // row remains (the trash icon is also disabled on the last row so
  // this is defense-in-depth). When the first row is removed the
  // legacy mirror fields (domain, pathPrefix, port, sslEnabled) are
  // resynced from the new routes[0] so the Phase 2 flat POST body
  // still carries the primary route values through the H.3 → H.6
  // intermediate window.
  const removeWizardRoute = (i) => {
    setFormData((f) => {
      if (f.routes.length <= 1) return f;
      const newRoutes = f.routes.filter((_, idx) => idx !== i);
      if (i === 0) {
        const primary = newRoutes[0];
        return {
          ...f,
          routes: newRoutes,
          domain: primary.domain,
          pathPrefix: primary.pathPrefix,
          port: primary.targetPort,
          sslEnabled: primary.sslEnabled,
        };
      }
      return { ...f, routes: newRoutes };
    });
  };

  // Phase 2b H.3: patch a single route row. When the primary route
  // (index 0) changes, mirror its fields onto the legacy top-level
  // formData keys so `handleAddService` (still on the Phase 2 flat
  // payload until H.6) keeps receiving the correct values.
  const updateWizardRoute = (i, patch) => {
    setFormData((f) => {
      const newRoutes = f.routes.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
      if (i === 0) {
        const primary = newRoutes[0];
        return {
          ...f,
          routes: newRoutes,
          domain: primary.domain,
          pathPrefix: primary.pathPrefix,
          port: primary.targetPort,
          sslEnabled: primary.sslEnabled,
        };
      }
      return { ...f, routes: newRoutes };
    });
  };

  // Phase 2b H.2: allow the operator to back out of the runtime pick
  // without bailing to Step 0. Clears runtime + LXC picker state so the
  // sub-step renders fresh tiles again.
  const handleRuntimeChange = () => {
    setFormData((f) => ({
      ...f,
      runtime: null,
      lxcContainerName: '',
      targetIp: '',
    }));
    setLxcWizardContainers([]);
    setLxcWizardError('');
  };

  // Phase 2b H.1: handler for the new two-tile kind picker at Step 0.
  // static_site → kind='static_site' + type='static' (backend D.2 still
  // reads `type`, so both fields stay in sync during the transitional
  // period until D.2 is refactored to accept nested routes).
  // container_service → kind='container_service' + runtime=null (runtime
  // is filled in at Step 1 by the H.2 picker). `type` is temporarily set
  // to 'docker' so the existing Step 1 form renders its container inputs
  // until H.2/H.3 land. Both `lxcContainerName` and `targetIp` reset so a
  // second run through the wizard does not leak state from a previous
  // container_service pick.
  const handleKindSelect = (kind) => {
    if (kind === 'static_site') {
      setFormData({
        ...formData,
        kind: 'static_site',
        type: 'static',
        runtime: null,
        lxcContainerName: '',
        targetIp: '',
      });
    } else {
      // container_service: runtime starts null so the H.2 Step 1
      // sub-step renders its "Pick runtime" tiles. `type` stays blank
      // until handleRuntimeSelect maps it onto the legacy field (lxc +
      // docker both become type='docker' since D.2 only knows about
      // the 'static' and 'docker' enum values).
      setFormData({
        ...formData,
        kind: 'container_service',
        type: '',
        runtime: null,
        lxcContainerName: '',
        targetIp: '',
        containerName: '',
      });
      // Clear any leftover LXC picker state from a previous open.
      setLxcWizardContainers([]);
      setLxcWizardError('');
    }
    setWizardStep(1);
  };

  // Phase 2b post-H.1 follow-up: four-tile Step 0 picker that pre-fills
  // both `kind` and `runtime` in one click, restoring the at-a-glance
  // discoverability of the original four-choice picker (Static / Docker
  // / LXC / Compose) while keeping the H.2-H.6 backend wiring intact.
  // The H.2 sub-step still exists as a fallback for any code path that
  // lands on Step 1 with kind=container_service AND runtime=null, but
  // the four-tile flow always pre-fills both so the sub-step is
  // effectively skipped.
  //
  // tile values:
  //   - 'static_site' → reuses handleKindSelect's static path
  //   - 'docker'      → kind=container_service, runtime=docker
  //   - 'lxc'         → kind=container_service, runtime=lxc + LXC fetch
  //   - 'compose'     → closes the dialog and switches to the Compose tab
  const handleStep0Tile = async (tile) => {
    if (tile === 'compose') {
      setAddDialogOpen(false);
      setDashboardTab('compose');
      return;
    }
    if (tile === 'static_site') {
      handleKindSelect('static_site');
      return;
    }
    // 'docker' or 'lxc'
    const runtime = tile;
    setFormData((f) => ({
      ...f,
      kind: 'container_service',
      runtime,
      // Both runtimes map to the legacy 'docker' type since D.2's
      // Phase 2 schema only knows 'static'|'docker'.
      type: 'docker',
      lxcContainerName: '',
      targetIp: runtime === 'docker' ? (f.target || '127.0.0.1') : '',
      containerName: runtime === 'docker' ? f.containerName : '',
    }));
    setWizardStep(1);
    if (runtime === 'lxc') {
      setLxcWizardLoading(true);
      setLxcWizardError('');
      try {
        const { containers } = await api.getLxcContainersWithIp();
        setLxcWizardContainers(containers || []);
      } catch (err) {
        setLxcWizardError(err.message || 'Failed to load LXC containers');
        setLxcWizardContainers([]);
      } finally {
        setLxcWizardLoading(false);
      }
    }
  };

  // Phase 2: extracted from the inline `.map` in the services grid so the
  // grouped renderer can call it. The card body is byte-for-byte identical
  // to the pre-Phase-2 inline version — only the surrounding control flow
  // (grouping vs flat) was added.
  const renderServiceCard = (service) => (
    <Card
      key={service.id}
      draggable
      onDragStart={(e) => handleServiceDragStart(e, service)}
      onDragEnd={handleServiceDragEnd}
      className={`${service.isAdmin ? 'border-primary' : ''} ${service.isFavorite ? 'ring-1 ring-yellow-500/50' : ''} ${draggedService?.id === service.id ? 'opacity-50' : ''} cursor-grab active:cursor-grabbing`}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            {getServiceIcon(service.type)}
            <CardTitle className="text-lg truncate">{service.name}</CardTitle>
          </div>
          <div className="flex items-center gap-1 flex-wrap justify-end">
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => handleToggleFavorite(service, e)}
              title={service.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            >
              <Star className={`h-4 w-4 ${service.isFavorite ? 'fill-yellow-500 text-yellow-500' : ''}`} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setSelectedServiceForFolder(service);
                setFolderDialogOpen(true);
              }}
              title="Move to folder"
            >
              <Folder className="h-4 w-4" />
            </Button>
            {!service.isAdmin && (
              <>
                {/* Settings button for all service types */}
                <Button variant="ghost" size="icon" onClick={() => openSettings(service)} title="Service Settings">
                  <Server className="h-4 w-4" />
                </Button>
                {/* File editor for static sites only */}
                {service.type === 'static' && (
                  <Button variant="ghost" size="icon" onClick={() => openEditor(service)} title="Manage Files">
                    <FileText className="h-4 w-4" />
                  </Button>
                )}
                {isAdmin && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => openTerminal(getServiceDirectory(service))}
                    title="Open Terminal"
                  >
                    <Terminal className="h-4 w-4" />
                  </Button>
                )}
                <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive" onClick={() => openDeleteDialog(service)} title="Delete Service">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            )}
            {service.isAdmin && <Shield className="h-5 w-5 text-primary" title="Admin Dashboard" />}
          </div>
        </div>
        <CardDescription className="flex items-center gap-1">
          <Globe className="h-3 w-3" />
          {/* Clickable URL: opens the live site in a new tab.
              stopPropagation so the click doesn't trigger the card's
              drag/select handlers; draggable=false so the browser's
              default anchor-drag behaviour doesn't compete with the
              card's draggable=true. Protocol picks https whenever SSL
              is on the route — matches what Caddy is actually serving. */}
          <a
            href={`${service.sslEnabled ? 'https' : 'http'}://${service.domain}${service.pathPrefix && service.pathPrefix !== '/' ? service.pathPrefix : ''}`}
            target="_blank"
            rel="noopener noreferrer"
            draggable={false}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="hover:underline hover:text-primary transition-colors flex items-center gap-1"
            title="Open in new tab"
          >
            {service.domain}
            {service.pathPrefix && service.pathPrefix !== '/' && (
              <span className="font-mono text-xs text-muted-foreground">{service.pathPrefix}</span>
            )}
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Type</span>
            <span className="capitalize">{service.type}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Location</span>
            <span className="font-mono text-xs truncate max-w-[150px]">{getServiceLocation(service)}</span>
          </div>
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">SSL</span>
            <span className="flex items-center gap-1">
              {service.sslEnabled ? (
                service.sslCertificateExists ? (
                  <>
                    <ShieldCheck className="h-3 w-3 text-green-500" />
                    <span className="text-green-500">Active</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 ml-1 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                      onClick={(e) => openRemoveCertDialog(service, e)}
                      title="Remove SSL Certificate"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </>
                ) : (
                  <>
                    <ShieldAlert className="h-3 w-3 text-yellow-500" />
                    <span className="text-yellow-500" title="SSL enabled but certificate not found">Pending</span>
                    {obtainingCert === service.id ? (
                      <Loader2 className="h-3 w-3 ml-1 animate-spin" />
                    ) : (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 ml-1"
                          onClick={(e) => handleObtainCertificate(service, e)}
                          title="Obtain SSL Certificate"
                        >
                          <Shield className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5"
                          onClick={(e) => handleRegenerateConfig(service, e)}
                          title="Regenerate config"
                        >
                          <RefreshCcw className="h-3 w-3" />
                        </Button>
                      </>
                    )}
                  </>
                )
              ) : (
                <span>Disabled</span>
              )}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Status</span>
            <span className={`capitalize ${service.status === 'active' ? 'text-green-500' : 'text-red-500'}`}>{service.status}</span>
          </div>
          {/* Folder Badge */}
          {getServiceFolder(service.id) && (
            <div className="flex justify-between items-center pt-1 border-t mt-2">
              <span className="text-muted-foreground">Folder</span>
              <span className="flex items-center gap-1 text-xs bg-yellow-500/10 text-yellow-600 px-2 py-0.5 rounded">
                <Folder className="h-3 w-3" />
                {serviceFolders[getServiceFolder(service.id)]?.name}
              </span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );

  const handleAddService = async (e) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      // Phase 2b H.5: generalized client-side collision guard. The
      // wizard may submit multiple routes at once (via the H.3 routes
      // builder), so the guard walks `formData.routes` and rejects:
      //   (a) in-wizard duplicates — two rows with the same
      //       `(domain, pathPrefix)` tuple. Fails with a toast naming
      //       the duplicate so the operator can spot it.
      //   (b) collisions against any existing route across all
      //       services — any row whose `(domain, pathPrefix)` tuple is
      //       already present in the backend's nested routes array.
      //       Fails with the same error text the backend returns so
      //       the two surfaces stay consistent.
      // Normalization mirrors the backend's: trim, prepend a leading
      // slash if missing, strip trailing slashes, default empty → '/'.
      const normalize = (value) => {
        if (value === undefined || value === null || value === '') return '/';
        let p = String(value).trim();
        if (!p.startsWith('/')) p = '/' + p;
        if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
        return p || '/';
      };
      const normalizeDomain = (d) => (d || '').toLowerCase().trim();

      // Build a Set of existing (domain, prefix) tuples across every
      // service's nested routes, with a legacy-shape fallback for
      // services still on the Phase 2 flat shape.
      const existingTuples = new Set();
      for (const svc of services) {
        if (Array.isArray(svc.routes) && svc.routes.length > 0) {
          for (const r of svc.routes) {
            existingTuples.add(
              `${normalizeDomain(r.domain)}|${normalize(r.pathPrefix)}`
            );
          }
        } else if (svc.domain) {
          existingTuples.add(
            `${normalizeDomain(svc.domain)}|${normalize(svc.pathPrefix)}`
          );
        }
      }

      // Pass 1: intra-wizard duplicate detection.
      const seen = new Set();
      for (let i = 0; i < formData.routes.length; i++) {
        const r = formData.routes[i];
        const d = normalizeDomain(r.domain);
        const p = normalize(r.pathPrefix);
        if (!d) {
          setSubmitting(false);
          toast({
            variant: 'destructive',
            title: 'Error',
            description: `Route ${i + 1} is missing a domain`,
          });
          return;
        }
        const key = `${d}|${p}`;
        if (seen.has(key)) {
          setSubmitting(false);
          toast({
            variant: 'destructive',
            title: 'Error',
            description: `Duplicate (domain, path_prefix) in this wizard: ${d}${p}`,
          });
          return;
        }
        seen.add(key);
      }

      // Pass 2: collisions against any existing route.
      for (const r of formData.routes) {
        const d = normalizeDomain(r.domain);
        const p = normalize(r.pathPrefix);
        if (existingTuples.has(`${d}|${p}`)) {
          setSubmitting(false);
          toast({
            variant: 'destructive',
            title: 'Error',
            description: 'Domain + path prefix combination already exists',
          });
          return;
        }
      }

      // Phase 2b H.6: build the primary-route submit payload from
      // routes[0] + the service-level fields, then POST it to D.2's
      // still-flat endpoint. Any additional routes (routes[1..]) are
      // fanned out as api.createRoute calls against the freshly
      // created service id. This is the "Option (b)" approach from
      // the phase prompt: D.2 keeps the Phase 2 flat contract and
      // the wizard layers the nested-routes flow on top of it. The
      // only backend concession is D.2's optional `kind` / `runtime`
      // / `lxcContainerName` / `targetIp` fields so LXC runtime
      // metadata can land in one round trip.
      const primaryRoute = formData.routes[0];
      const additionalRoutes = formData.routes.slice(1);
      const submitData = {
        name: formData.name,
        domain: primaryRoute.domain,
        pathPrefix: normalize(primaryRoute.pathPrefix),
        type: formData.kind === 'static_site' ? 'static' : 'docker',
        target: formData.targetIp || formData.target || '127.0.0.1',
        containerName: formData.containerName || undefined,
        rootDir: formData.rootDir || undefined,
        sslEnabled: !!primaryRoute.sslEnabled,
        forceHttps: formData.forceHttps,
        websocketEnabled: formData.websocketEnabled,
        maxUploadSize: formData.maxUploadSize,
        obtainCertificate: formData.obtainCertificate,
      };
      // Only container_service rows need a targetPort on the primary
      // route. Static sites ignore the port entirely.
      if (formData.kind === 'container_service' && primaryRoute.targetPort) {
        submitData.port = parseInt(primaryRoute.targetPort, 10);
      }
      // Phase 2b H.6: when the operator picked the LXC runtime the
      // wizard has the container name + cached IP captured in
      // formData. Forward both through D.2's optional metadata
      // fields so services.runtime lands as 'lxc' and
      // services.lxc_container_name is populated for the Refresh IP
      // button (I.2) and for future LXC-aware features. Docker and
      // static_site skip these fields so D.2's legacy inference runs
      // unchanged.
      if (formData.kind === 'container_service' && formData.runtime === 'lxc') {
        submitData.kind = 'container_service';
        submitData.runtime = 'lxc';
        submitData.lxcContainerName = formData.lxcContainerName;
        submitData.targetIp = formData.targetIp;
      }

      const createRes = await api.createService(submitData);
      const createdServiceId = createRes?.service?.id;
      if (!createdServiceId) {
        throw new Error('Service create did not return an id');
      }

      // Fan out additional routes one at a time. If any fails, stop
      // and surface the first failure so the operator knows which
      // route to retry. The already-created service + primary route
      // remain in place — they will be visible on the next refetch.
      for (let i = 0; i < additionalRoutes.length; i++) {
        const r = additionalRoutes[i];
        const routeBody = {
          domain: r.domain,
          pathPrefix: normalize(r.pathPrefix),
          targetPort:
            formData.kind === 'container_service' && r.targetPort
              ? parseInt(r.targetPort, 10)
              : undefined,
          sslEnabled: !!r.sslEnabled,
          forceHttps: formData.forceHttps,
          websocketEnabled: formData.websocketEnabled,
          maxUploadSize: formData.maxUploadSize,
        };
        try {
          await api.createRoute(createdServiceId, routeBody);
        } catch (routeErr) {
          toast({
            variant: 'destructive',
            title: `Route ${i + 2} failed to create`,
            description: `${r.domain}${normalize(r.pathPrefix)}: ${routeErr.message}`,
          });
          // The primary route + service still exist; refresh to
          // show the partial state so the operator can recover via
          // the Routes card (I.1).
          setAddDialogOpen(false);
          resetForm();
          fetchServices();
          return;
        }
      }

      toast({
        title: 'Success',
        description:
          formData.routes.length > 1
            ? `Service created with ${formData.routes.length} routes`
            : 'Service created successfully',
      });
      setAddDialogOpen(false);
      resetForm();
      fetchServices();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteService = async (passkeyAssertion = null) => {
    if (!serviceToDelete) return;
    if (!passkeyAssertion && !totpCode) return;
    setSubmitting(true);

    try {
      await api.deleteService(serviceToDelete.id, passkeyAssertion
        ? { passkeyAssertion }
        : { totpCode });
      toast({
        title: 'Success',
        description: 'Service deleted successfully',
      });
      setDeleteDialogOpen(false);
      setServiceToDelete(null);
      setTotpCode('');
      fetchServices();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleFavorite = async (service, e) => {
    e.stopPropagation();
    try {
      await api.toggleFavorite(service.id);
      setServices(prev => prev.map(s =>
        s.id === service.id ? { ...s, isFavorite: !s.isFavorite } : s
      ));
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    }
  };

  const handleReloadCaddy = async () => {
    try {
      await api.reloadCaddy();
      toast({
        title: 'Success',
        description: 'Caddy reloaded successfully',
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    }
  };

  const [regeneratingAll, setRegeneratingAll] = useState(false);

  const handleRegenerateAllConfigs = async () => {
    setRegeneratingAll(true);
    try {
      const result = await api.regenerateAllConfigs();
      toast({
        title: result.caddyReloaded ? 'Success' : 'Partial Success',
        description: `Regenerated ${result.results.success.length} configs${result.results.failed.length > 0 ? `, ${result.results.failed.length} failed` : ''}. Caddy ${result.caddyReloaded ? 'reloaded' : 'reload failed'}`,
      });
      fetchServices();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setRegeneratingAll(false);
    }
  };

  const handleRegenerateConfig = async (service, e) => {
    e.stopPropagation();
    try {
      const result = await api.regenerateConfig(service.id);
      toast({
        title: result.sslCertificateExists ? 'Success' : 'Config Updated',
        description: result.sslCertificateExists
          ? 'Configuration regenerated with SSL enabled'
          : 'Configuration regenerated. Enable SSL in settings and Caddy will automatically obtain a certificate.',
      });
      fetchServices();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    }
  };

  const [obtainingCert, setObtainingCert] = useState(null);

  const handleObtainCertificate = async (service, e) => {
    e.stopPropagation();
    setObtainingCert(service.id);
    try {
      const result = await api.obtainCertificate(service.id);
      toast({
        title: result.success ? 'Success' : 'Warning',
        description: result.message || (result.success ? 'SSL certificate obtained' : 'Failed to obtain certificate'),
      });
      fetchServices();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setObtainingCert(null);
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      routes: [
        { id: pp2bRouteUid(), domain: '', pathPrefix: '/', targetPort: '', sslEnabled: true },
      ],
      rootDir: '',
      domain: '',
      pathPrefix: '/',
      kind: '',
      runtime: null,
      targetIp: '',
      lxcContainerName: '',
      type: '',
      target: '127.0.0.1',
      port: '',
      containerName: '',
      sslEnabled: true,
      forceHttps: true,
      websocketEnabled: false,
      maxUploadSize: '1G',
      obtainCertificate: true,
    });
    setWizardStep(0);
    setLxcWizardContainers([]);
    setLxcWizardLoading(false);
    setLxcWizardError('');
  };

  const openDeleteDialog = (service) => {
    setServiceToDelete(service);
    setTotpCode('');
    setDeleteDialogOpen(true);
  };

  const openRemoveCertDialog = (service, e) => {
    e.stopPropagation();
    setServiceToRemoveCert(service);
    setTotpCode('');
    setRemoveCertDialogOpen(true);
  };

  const confirmRemoveCertificate = async (passkeyAssertion = null) => {
    if (!serviceToRemoveCert) return;
    if (!passkeyAssertion && !totpCode) return;

    setSubmitting(true);
    try {
      await api.removeCertificate(serviceToRemoveCert.id, passkeyAssertion
        ? { passkeyAssertion }
        : { totpCode });
      toast({
        title: 'Certificate Removed',
        description: `SSL certificate for ${serviceToRemoveCert.domain} has been removed`,
      });
      setRemoveCertDialogOpen(false);
      setServiceToRemoveCert(null);
      setTotpCode('');
      fetchServices();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setSubmitting(false);
    }
  };

  // Terminal Functions
  const fetchTerminalDirectory = async (dir, forceRefresh = false) => {
    setLoadingTerminalFiles(true);
    // Clear existing files to force visual refresh when explicitly requested
    if (forceRefresh) {
      setTerminalFiles([]);
    }
    try {
      // Add timestamp to prevent any potential caching issues
      const result = await api.executeCommand(`ls -la "${dir}" 2>/dev/null | tail -n +2 # ${Date.now()}`, '/');
      if (result.success && result.output) {
        const items = [];
        const lines = result.output.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          const parts = line.split(/\s+/);
          if (parts.length >= 9) {
            const perms = parts[0];
            const name = parts.slice(8).join(' ');
            if (name === '.' || name === '..') continue;
            items.push({
              name,
              isDir: perms.startsWith('d'),
              perms,
              size: parts[4],
            });
          }
        }
        // Sort: folders first, then files
        items.sort((a, b) => {
          if (a.isDir && !b.isDir) return -1;
          if (!a.isDir && b.isDir) return 1;
          return a.name.localeCompare(b.name);
        });
        setTerminalFiles(items);
      }
    } catch (e) {
      console.error('Failed to fetch directory:', e);
    } finally {
      setLoadingTerminalFiles(false);
    }
  };

  // Upload files to the current terminal directory
  const handleTerminalFileUpload = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (const file of files) {
      try {
        const reader = new FileReader();
        const base64Content = await new Promise((resolve, reject) => {
          reader.onload = () => {
            const base64 = reader.result.split(',')[1];
            resolve(base64);
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        const result = await api.uploadFileToDirectory(terminalCwd, file.name, base64Content, 'base64');
        if (result.success) {
          setTerminalOutput(prev => [...prev, { type: 'system', text: `Uploaded: ${file.name} (${file.size} bytes)` }]);
        }
      } catch (err) {
        setTerminalOutput(prev => [...prev, { type: 'error', text: `Failed to upload ${file.name}: ${err.message}` }]);
      }
    }
    // Refresh file list
    fetchTerminalDirectory(terminalCwd, true);
    // Reset input
    e.target.value = '';
  };

  const openTerminal = async (initialDir = null) => {
    // Always start with /root if no directory specified
    const startDir = initialDir || '/root';
    setTerminalCwd(startDir);
    setTerminalInitialCwd(startDir);
    setTerminalFullscreen(true);
    setTerminalOutput(prev => prev.length === 0 ? [{ type: 'system', text: 'Terminal ready. Type commands and press Enter.' }] : prev);
    // Open dialog after state is set
    setTerminalOpen(true);

    // Fetch system info and containers
    try {
      const [sysInfo, containerList] = await Promise.all([
        api.getSystemInfo().catch(() => null),
        api.listContainers().catch(() => ({ containers: [] })),
      ]);
      setSystemInfo(sysInfo || null);
      setContainers(containerList?.containers || []);
      // Fetch directory contents for the starting directory
      fetchTerminalDirectory(startDir);
      // Also fetch docker-compose containers for current directory
      fetchComposeContainersForDir(startDir);
    } catch (e) {
      console.error('Failed to fetch terminal info:', e);
    }
  };

  // Fetch docker-compose containers for a specific directory
  const fetchComposeContainersForDir = async (dir) => {
    try {
      // Check if docker-compose.yml exists in the directory
      const checkResult = await api.executeCommand(`test -f "${dir}/docker-compose.yml" && echo "exists" || echo "no"`, '/');
      if (checkResult.output?.trim() === 'exists') {
        // Get compose project name from directory
        const projectName = dir.split('/').pop();
        // Get containers for this compose project
        const result = await api.executeCommand(
          `docker compose -f "${dir}/docker-compose.yml" ps --format '{{.Name}}\\t{{.Image}}\\t{{.Status}}' 2>/dev/null || echo ""`,
          '/'
        );
        if (result.output?.trim()) {
          const composeContainers = result.output.trim().split('\n').filter(Boolean).map(line => {
            const [name, image, status] = line.split('\t');
            return { name, image, status, isRunning: status?.includes('Up') };
          });
          setContainers(composeContainers);
        }
      }
    } catch (e) {
      console.error('Failed to fetch compose containers:', e);
    }
  };

  // Tab completion for terminal
  const handleTabComplete = async () => {
    const input = terminalCommand;
    const parts = input.split(/\s+/);
    const lastPart = parts[parts.length - 1] || '';

    // Get directory and partial filename
    let searchDir = terminalCwd;
    let searchPrefix = lastPart;

    if (lastPart.includes('/')) {
      const lastSlash = lastPart.lastIndexOf('/');
      const dirPart = lastPart.substring(0, lastSlash) || '/';
      searchPrefix = lastPart.substring(lastSlash + 1);
      searchDir = dirPart.startsWith('/') ? dirPart : `${terminalCwd}/${dirPart}`.replace(/\/+/g, '/');
    }

    try {
      const result = await api.executeCommand(`ls -1 "${searchDir}" 2>/dev/null | grep "^${searchPrefix}"`, '/');
      if (result.success && result.output) {
        const matches = result.output.trim().split('\n').filter(Boolean);
        if (matches.length === 1) {
          // Single match - complete it
          const match = matches[0];
          const prefix = lastPart.includes('/') ? lastPart.substring(0, lastPart.lastIndexOf('/') + 1) : '';
          parts[parts.length - 1] = prefix + match;
          setTerminalCommand(parts.join(' '));
          setShowTabSuggestions(false);
        } else if (matches.length > 1) {
          // Multiple matches - show suggestions
          setTabSuggestions(matches);
          setShowTabSuggestions(true);
        }
      }
    } catch (e) {
      // No completions available
    }
  };

  const executeTerminalCommand = async () => {
    if (!terminalCommand.trim() || terminalRunning) return;

    const cmd = terminalCommand.trim();

    // Add to command history
    setCommandHistory(prev => {
      const newHistory = [...prev.filter(c => c !== cmd), cmd];
      return newHistory.slice(-100); // Keep last 100 commands
    });
    setHistoryIndex(-1);

    setTerminalOutput(prev => [...prev, { type: 'input', text: `${terminalCwd}$ ${cmd}` }]);
    setTerminalCommand('');
    setShowTabSuggestions(false);

    // Handle special commands locally
    if (cmd === 'clear') {
      setTerminalOutput([]);
      terminalInputRef.current?.focus();
      return;
    }

    // Intercept nano/vim/vi command and open built-in editor
    if (cmd.startsWith('nano ') || cmd === 'nano' || cmd.startsWith('vim ') || cmd.startsWith('vi ')) {
      const cmdName = cmd.split(' ')[0];
      const filePath = cmd === 'nano' ? '' : cmd.substring(cmdName.length + 1).trim();
      if (!filePath) {
        setTerminalOutput(prev => [...prev, { type: 'error', text: `Usage: ${cmdName} <filename>` }]);
        terminalInputRef.current?.focus();
        return;
      }

      // Resolve full path based on current directory
      const fullPath = filePath.startsWith('/') ? filePath : `${terminalCwd}/${filePath}`.replace(/\/+/g, '/');

      // Open in the editor tab
      openFileInEditor(fullPath);
      terminalInputRef.current?.focus();
      return;
    }

    setTerminalRunning(true);

    // Create abort controller for this command
    const abortController = new AbortController();
    terminalAbortRef.current = abortController;

    try {
      // Handle cd command - need to track directory
      if (cmd.startsWith('cd ') || cmd === 'cd') {
        const targetDir = cmd === 'cd' ? '~' : cmd.substring(3).trim();
        // Execute cd and pwd to get the new directory
        const cdCmd = `cd ${terminalCwd} && cd ${targetDir} && pwd`;
        const result = await api.executeCommand(cdCmd, '/', undefined, abortController.signal);
        if (result.success && result.output) {
          const newCwd = result.output.trim();
          setTerminalCwd(newCwd);
          fetchTerminalDirectory(newCwd); // Refresh file browser
          fetchComposeContainersForDir(newCwd); // Refresh docker-compose containers
          setTerminalOutput(prev => [
            ...prev,
            { type: 'system', text: `Changed directory to: ${newCwd}` },
          ]);
        } else {
          setTerminalOutput(prev => [
            ...prev,
            { type: 'error', text: result.output || 'Failed to change directory' },
          ]);
        }
      } else {
        // Execute command in current working directory
        const result = await api.executeCommand(cmd, terminalCwd, undefined, abortController.signal);
        setTerminalOutput(prev => [
          ...prev,
          {
            type: result.success ? 'output' : 'error',
            text: result.output || '(no output)',
            exitCode: result.exitCode,
            duration: result.duration,
          },
        ]);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        setTerminalOutput(prev => [
          ...prev,
          { type: 'system', text: 'Command cancelled by user (note: the command may still be running on the server)' },
        ]);
      } else {
        setTerminalOutput(prev => [
          ...prev,
          { type: 'error', text: error.message },
        ]);
      }
    } finally {
      setTerminalRunning(false);
      terminalAbortRef.current = null;
      // Re-focus the input after command completes
      setTimeout(() => terminalInputRef.current?.focus(), 0);
    }
  };

  const cancelTerminalCommand = () => {
    if (terminalAbortRef.current) {
      terminalAbortRef.current.abort();
      terminalAbortRef.current = null;
    }
  };

  const handleContainerAction = async (action, container) => {
    try {
      const result = await api.containerAction(action, container.id);
      toast({
        title: result.success ? 'Success' : 'Error',
        description: result.message || result.error,
        variant: result.success ? 'default' : 'destructive',
      });
      // Refresh containers
      const containerList = await api.listContainers();
      setContainers(containerList.containers || []);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    }
  };

  const refreshContainers = async () => {
    try {
      const containerList = await api.listContainers();
      setContainers(containerList.containers || []);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to refresh containers',
      });
    }
  };

  // Docker Compose action handlers
  const handleComposeAction = async (action, project) => {
    const firstService = project.services[0];
    const composeDir = firstService?.composeDir || `/root/docker/${project.projectName}`;
    const composePath = `${composeDir}/docker-compose.yml`;

    const loadingKey = `${project.projectName}-${action}`;
    setComposeActionLoading(prev => ({ ...prev, [loadingKey]: true }));

    try {
      const result = await api.dockerCompose(action, composePath);
      toast({
        title: result.success ? 'Success' : 'Error',
        description: result.success
          ? `${action.charAt(0).toUpperCase() + action.slice(1)} completed for ${project.projectName}`
          : result.output,
        variant: result.success ? 'default' : 'destructive',
      });
      // Refresh compose services after action
      fetchComposeServices();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setComposeActionLoading(prev => ({ ...prev, [loadingKey]: false }));
    }
  };

  const openDestroyDialog = (project) => {
    const firstService = project.services[0];
    const composeDir = firstService?.composeDir || `/root/docker/${project.projectName}`;
    setProjectToDestroy({ ...project, composeDir, composePath: `${composeDir}/docker-compose.yml` });
    setDestroyTotpCode('');
    setDestroyOptions({
      removeVolumes: false,
      removeImages: false,
      removeOrphans: true,
      prune: false,
    });
    setDestroyDialogOpen(true);
  };

  const handleDestroyProject = async (passkeyAssertion = null) => {
    if (!projectToDestroy) return;
    if (!passkeyAssertion && destroyTotpCode.length !== 6) return;

    setDestroyingProject(true);
    try {
      const result = await api.dockerComposeDestroy(
        projectToDestroy.composePath,
        passkeyAssertion ? { passkeyAssertion } : { totpCode: destroyTotpCode },
        destroyOptions
      );
      toast({
        title: result.success ? 'Destroyed' : 'Error',
        description: result.success
          ? `${projectToDestroy.projectName} has been destroyed`
          : result.output,
        variant: result.success ? 'default' : 'destructive',
      });
      setDestroyDialogOpen(false);
      fetchComposeServices();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setDestroyingProject(false);
    }
  };

  // Docker Compose create handler
  const handleCreateCompose = async () => {
    if (!composeCreateForm.serviceName.trim()) {
      toast({ variant: 'destructive', title: 'Error', description: 'Service name is required' });
      return;
    }

    setComposeCreating(true);
    const folderName = composeCreateForm.serviceName.toLowerCase().replace(/\s+/g, '-');
    const composePath = `/root/docker/${folderName}`;

    try {
      // Create directory and write docker-compose.yml
      await api.executeCommand(`mkdir -p "${composePath}"`, '/');
      await api.writeFile(`${composePath}/docker-compose.yml`, composeCreateForm.composeContent);

      // Write .env file if there are environment variables
      if (composeCreateForm.envVars && composeCreateForm.envVars.length > 0) {
        const envContent = composeCreateForm.envVars
          .filter(env => env.key.trim())
          .map(env => {
            const processedValue = processEnvValue(env.value);
            return `${env.key}=${processedValue}`;
          })
          .join('\n');
        if (envContent) {
          await api.writeFile(`${composePath}/.env`, envContent);
        }
      }

      // Start the compose project
      const result = await api.dockerCompose('up', `${composePath}/docker-compose.yml`);

      if (result.success) {
        toast({
          title: 'Success',
          description: `Docker Compose project "${composeCreateForm.serviceName}" created and started`,
        });

        // Refresh compose services
        await fetchComposeServices();

        // Parse ports from compose file or running containers
        const portsResult = await api.executeCommand(
          `docker compose -f "${composePath}/docker-compose.yml" ps --format '{{.Ports}}' 2>/dev/null | grep -oE '[0-9]+->|:[0-9]+' | grep -oE '[0-9]+' | sort -u`,
          '/'
        );

        const exposedPorts = portsResult.output?.trim().split('\n').filter(Boolean) || [];

        // Pre-fill the proxy container form. Phase 2b H.3: seed a
        // single-route array keyed on the first exposed port so the new
        // routes builder lands ready-to-submit. The legacy top-level
        // (domain, pathPrefix, port, sslEnabled) mirror fields stay in
        // sync with routes[0] for the Phase 2 flat POST payload.
        setFormData({
          name: composeCreateForm.serviceName,
          kind: 'container_service',
          runtime: 'docker',
          lxcContainerName: '',
          targetIp: '127.0.0.1',
          routes: [
            {
              id: pp2bRouteUid(),
              domain: '',
              pathPrefix: '/',
              targetPort: exposedPorts[0] || '',
              sslEnabled: true,
            },
          ],
          rootDir: '',
          domain: '',
          pathPrefix: '/',
          type: 'docker',
          target: '127.0.0.1',
          port: exposedPorts[0] || '',
          containerName: folderName,
          sslEnabled: true,
          forceHttps: true,
          websocketEnabled: false,
          maxUploadSize: '1G',
          obtainCertificate: true,
        });
        setWizardStep(1);
        setComposeCreateOpen(false);
        setAddDialogOpen(true);
      } else {
        toast({ variant: 'destructive', title: 'Error', description: result.output });
      }
    } catch (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
    } finally {
      setComposeCreating(false);
    }
  };

  // Folder management functions
  const saveServiceFolders = (folders) => {
    setServiceFolders(folders);
    localStorage.setItem('serviceFolders', JSON.stringify(folders));
  };

  const createFolder = (name, parentPath = null) => {
    const newPath = parentPath ? `${parentPath}/${name}` : name;
    // Calculate order for new folder (highest + 1)
    const siblingFolders = Object.entries(serviceFolders).filter(([, f]) => f.parentPath === parentPath);
    const maxOrder = siblingFolders.reduce((max, [, f]) => Math.max(max, f.order || 0), -1);
    saveServiceFolders({
      ...serviceFolders,
      [newPath]: { name, services: [], parentPath, order: maxOrder + 1 },
    });
  };

  // Reorder folder to a specific position (before or after target folder)
  const reorderFolderToPosition = (sourcePath, targetPath, position) => {
    const sourceFolder = serviceFolders[sourcePath];
    const targetFolder = serviceFolders[targetPath];
    if (!sourceFolder || !targetFolder) return;
    if (sourcePath === targetPath) return;

    // Only allow reordering within the same parent level
    if (sourceFolder.parentPath !== targetFolder.parentPath) return;

    // Get sibling folders (same parent)
    const siblings = Object.entries(serviceFolders)
      .filter(([, f]) => f.parentPath === sourceFolder.parentPath)
      .sort((a, b) => (a[1].order || 0) - (b[1].order || 0));

    // Remove source from current position
    const filteredSiblings = siblings.filter(([path]) => path !== sourcePath);

    // Find target index in filtered list
    const targetIndex = filteredSiblings.findIndex(([path]) => path === targetPath);
    if (targetIndex === -1) return;

    // Insert source at new position
    const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
    filteredSiblings.splice(insertIndex, 0, [sourcePath, sourceFolder]);

    // Reassign order values
    const newFolders = { ...serviceFolders };
    filteredSiblings.forEach(([path], index) => {
      newFolders[path] = { ...newFolders[path], order: index };
    });
    saveServiceFolders(newFolders);
  };

  const moveServiceToFolder = (serviceId, folderPath) => {
    // Remove service from all folders first
    const newFolders = { ...serviceFolders };
    Object.keys(newFolders).forEach(path => {
      if (newFolders[path].services) {
        newFolders[path].services = newFolders[path].services.filter(id => id !== serviceId);
      }
    });
    // Add to new folder
    if (folderPath && newFolders[folderPath]) {
      newFolders[folderPath].services = [...(newFolders[folderPath].services || []), serviceId];
    }
    saveServiceFolders(newFolders);
  };

  const moveFolderToFolder = (sourcePath, targetPath) => {
    // Don't allow moving to itself or its children
    if (sourcePath === targetPath || targetPath?.startsWith(sourcePath + '/')) {
      return false;
    }

    const newFolders = { ...serviceFolders };
    const sourceFolder = newFolders[sourcePath];
    if (!sourceFolder) return false;

    // Create new path
    const folderName = sourceFolder.name;
    const newPath = targetPath ? `${targetPath}/${folderName}` : folderName;

    // Move the folder and all its subfolders
    const foldersToMove = Object.entries(newFolders).filter(([path]) =>
      path === sourcePath || path.startsWith(sourcePath + '/')
    );

    foldersToMove.forEach(([oldPath, folder]) => {
      const relativePath = oldPath.slice(sourcePath.length);
      const updatedPath = newPath + relativePath;
      const newParent = updatedPath.includes('/')
        ? updatedPath.slice(0, updatedPath.lastIndexOf('/'))
        : null;

      delete newFolders[oldPath];
      newFolders[updatedPath] = { ...folder, parentPath: newParent };
    });

    saveServiceFolders(newFolders);
    return true;
  };

  const deleteFolder = (folderPath) => {
    const newFolders = { ...serviceFolders };
    // Delete the folder and all subfolders
    Object.keys(newFolders).forEach(path => {
      if (path === folderPath || path.startsWith(folderPath + '/')) {
        delete newFolders[path];
      }
    });
    saveServiceFolders(newFolders);
  };

  // Get root folders (folders without parent) - sorted by order
  const getRootFolders = () => {
    return Object.entries(serviceFolders)
      .filter(([path, folder]) => !folder.parentPath)
      .sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
  };

  // Get subfolders of a folder - sorted by order
  const getSubfolders = (parentPath) => {
    return Object.entries(serviceFolders)
      .filter(([path, folder]) => folder.parentPath === parentPath)
      .sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
  };

  // Drag and drop handlers for services
  const handleServiceDragStart = (e, service) => {
    setDraggedService(service);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleServiceDragEnd = () => {
    setDraggedService(null);
    setDragOverFolder(null);
  };

  // Drag and drop handlers for folders
  const handleFolderDragStart = (e, folderPath) => {
    setDraggedFolder(folderPath);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleFolderDragEnd = () => {
    setDraggedFolder(null);
    setDragOverFolder(null);
    setFolderDropPosition(null);
  };

  const handleFolderDragOver = (e, folderPath) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Detect position based on mouse Y relative to element
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseY = e.clientY - rect.top;
    const position = mouseY < rect.height / 2 ? 'before' : 'after';

    // Only show position indicator when dragging a folder (not a service)
    if (draggedFolder && draggedFolder !== folderPath) {
      // Check if they have the same parent (only allow reordering within same level)
      const sourceFolder = serviceFolders[draggedFolder];
      const targetFolder = serviceFolders[folderPath];
      if (sourceFolder?.parentPath === targetFolder?.parentPath) {
        setFolderDropPosition({ folderPath, position });
        setDragOverFolder(null); // Don't show "move into" indicator
        return;
      }
    }

    // For services or nesting folders, show standard drag over
    setFolderDropPosition(null);
    setDragOverFolder(folderPath);
  };

  const handleFolderDragLeave = () => {
    setDragOverFolder(null);
    setFolderDropPosition(null);
  };

  const handleFolderDrop = (e, targetPath) => {
    e.preventDefault();
    const dropPosition = folderDropPosition;
    setDragOverFolder(null);
    setFolderDropPosition(null);

    if (draggedService) {
      moveServiceToFolder(draggedService.id, targetPath);
      toast({
        title: 'Service moved',
        description: `"${draggedService.name}" moved to "${serviceFolders[targetPath]?.name || 'root'}"`
      });
      setDraggedService(null);
    } else if (draggedFolder && draggedFolder !== targetPath) {
      // Check if this is a reorder operation (same parent level)
      const sourceFolder = serviceFolders[draggedFolder];
      const targetFolder = serviceFolders[targetPath];
      if (sourceFolder?.parentPath === targetFolder?.parentPath && dropPosition) {
        reorderFolderToPosition(draggedFolder, targetPath, dropPosition.position);
        toast({
          title: 'Folder reordered',
          description: `Folder order updated`
        });
      } else if (moveFolderToFolder(draggedFolder, targetPath)) {
        toast({
          title: 'Folder moved',
          description: `Folder moved to "${serviceFolders[targetPath]?.name || 'root'}"`
        });
      }
      setDraggedFolder(null);
    }
  };

  const handleRootDrop = (e) => {
    e.preventDefault();
    setDragOverFolder(null);

    if (draggedService) {
      moveServiceToFolder(draggedService.id, null);
      toast({ title: 'Service moved', description: `"${draggedService.name}" removed from folder` });
      setDraggedService(null);
    } else if (draggedFolder) {
      if (moveFolderToFolder(draggedFolder, null)) {
        toast({ title: 'Folder moved', description: 'Folder moved to root' });
      }
      setDraggedFolder(null);
    }
  };

  // Get services in a specific folder
  const getServicesInFolder = (folderPath) => {
    const folder = serviceFolders[folderPath];
    if (!folder?.services) return [];
    return filteredServices.filter(s => folder.services.includes(s.id));
  };

  // Get services not in any folder
  const getUnfolderedServices = () => {
    const folderedServiceIds = Object.values(serviceFolders).flatMap(f => f.services || []);
    return filteredServices.filter(s => !folderedServiceIds.includes(s.id));
  };

  // Kill Switch Function
  const handleSecureSystem = async (passkeyAssertion = null) => {
    if (!passkeyAssertion && (!totpCode || totpCode.length !== 6)) return;
    setSecuringSystem(true);

    try {
      await api.secureSystem(passkeyAssertion
        ? { passkeyAssertion }
        : { totpCode });
      toast({
        title: 'System Secured',
        description: 'ProxyPilot is being secured. The dashboard will become unavailable.',
      });
      setKillSwitchDialogOpen(false);
      setTotpCode('');
      // Wait a moment then redirect to show secured page
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setSecuringSystem(false);
    }
  };

  // Nano Editor Save Function
  const handleNanoSave = async () => {
    if (!nanoFilePath) return;
    setNanoSaving(true);

    try {
      // Use dedicated file write API endpoint (bypasses terminal command limits)
      const result = await api.writeFile(nanoFilePath, nanoFileContent, true);

      if (result.success) {
        toast({
          title: 'File Saved',
          description: `Successfully saved ${nanoFilePath}`,
        });
        setNanoEditorOpen(false);
        setTerminalOutput(prev => [...prev, { type: 'system', text: `File saved: ${nanoFilePath}` }]);
      } else {
        throw new Error(result.error || 'Failed to save file');
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to save file: ' + error.message,
      });
    } finally {
      setNanoSaving(false);
    }
  };

  // Open file in the editor tab (within terminal dialog)
  const openFileInEditor = async (filePath) => {
    setEditorFilePath(filePath);
    setTerminalActiveTab('editor');
    setEditorShowVersions(false);

    try {
      const result = await api.executeCommand(`cat "${filePath}" 2>/dev/null || echo ""`, '/');
      const content = result.output || '';
      setEditorContent(content);
      setEditorOriginalContent(content);
      setTerminalOutput(prev => [...prev, { type: 'system', text: `Opening ${filePath} in editor...` }]);
    } catch (e) {
      setEditorContent('');
      setEditorOriginalContent('');
    }
  };

  // Save file from editor tab
  const handleEditorSave = async () => {
    if (!editorFilePath) return;
    setEditorSaving(true);

    try {
      const result = await api.writeFile(editorFilePath, editorContent, true);

      if (result.success) {
        // Auto-commit to git for version history
        const dir = editorFilePath.substring(0, editorFilePath.lastIndexOf('/'));
        const filename = editorFilePath.substring(editorFilePath.lastIndexOf('/') + 1);
        const timestamp = new Date().toLocaleString();

        // Initialize git repo if needed, add and commit the file
        await api.executeCommand(
          `cd "${dir}" && (git rev-parse --git-dir 2>/dev/null || git init) && git add "${filename}" && git commit -m "Update ${filename} - ${timestamp}" 2>/dev/null || true`,
          '/'
        );

        toast({
          title: 'File Saved',
          description: `Successfully saved ${editorFilePath}`,
        });
        setEditorOriginalContent(editorContent);
        setTerminalOutput(prev => [...prev, { type: 'system', text: `File saved: ${editorFilePath}` }]);
        // Refresh file browser to show any new files (force refresh to ensure UI updates)
        fetchTerminalDirectory(terminalCwd, true);
        // Refresh version history if panel is open
        if (editorShowVersions) {
          fetchEditorVersions();
        }
      } else {
        throw new Error(result.error || 'Failed to save file');
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to save file: ' + error.message,
      });
    } finally {
      setEditorSaving(false);
    }
  };

  // Fetch version history for a file in editor
  const fetchEditorVersions = async () => {
    if (!editorFilePath) return;
    setEditorLoadingVersions(true);

    try {
      // Try to get git log for the file
      const result = await api.executeCommand(
        `cd "$(dirname "${editorFilePath}")" && git log --oneline -20 -- "$(basename "${editorFilePath}")" 2>/dev/null || echo "no_git"`,
        '/'
      );

      if (result.output?.trim() === 'no_git' || !result.output?.trim()) {
        setEditorVersions([]);
      } else {
        const versions = result.output.trim().split('\n').map(line => {
          const [hash, ...messageParts] = line.split(' ');
          return { hash, message: messageParts.join(' ') };
        });
        setEditorVersions(versions);
      }
    } catch (e) {
      setEditorVersions([]);
    } finally {
      setEditorLoadingVersions(false);
    }
  };

  // Revert editor to a specific git version
  const revertEditorToVersion = async (hash) => {
    if (!editorFilePath || !hash) return;

    try {
      const result = await api.executeCommand(
        `cd "$(dirname "${editorFilePath}")" && git show ${hash}:"$(basename "${editorFilePath}")" 2>/dev/null`,
        '/'
      );

      if (result.success && result.output !== undefined) {
        setEditorContent(result.output);
        toast({
          title: 'Version Loaded',
          description: `Loaded version ${hash}. Save to apply changes.`,
        });
      } else {
        throw new Error('Failed to load version');
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load version: ' + error.message,
      });
    }
  };

  // Generate strong random password
  const generatePassword = (length = 24) => {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let password = '';
    const array = new Uint32Array(length);
    crypto.getRandomValues(array);
    for (let i = 0; i < length; i++) {
      password += chars[array[i] % chars.length];
    }
    return password;
  };

  // Check if port is available
  const checkPortAvailable = async (port) => {
    try {
      const result = await api.executeCommand(`ss -tlnp 2>/dev/null | grep -q ":${port} " && echo "used" || echo "free"`, '/');
      return result.output?.trim() === 'free';
    } catch {
      return true; // Assume available if check fails
    }
  };

  // Find next available port
  const findNextAvailablePort = async (startPort) => {
    let port = parseInt(startPort);
    for (let i = 0; i < 100; i++) {
      if (await checkPortAvailable(port)) return port;
      port++;
    }
    return port;
  };

  // One-Click Install WordPress
  const handleOneClickInstall = async () => {
    if (!oneClickForm.siteName || !oneClickForm.domain) {
      toast({ variant: 'destructive', title: 'Error', description: 'Site name and domain are required' });
      return;
    }

    setOneClickInstalling(true);
    const safeName = oneClickForm.siteName.toLowerCase().replace(/[^a-z0-9]/g, '');

    try {
      if (oneClickService === 'wordpress') {
        await installWordPress(safeName);
      }

      setOneClickDialogOpen(false);
      setOneClickService(null);
      setOneClickForm({ siteName: '', domain: '', wordpressPort: '7000', dbPort: '7001' });
      fetchServices();
      fetchComposeServices();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Installation Failed',
        description: error.message,
      });
    } finally {
      setOneClickInstalling(false);
    }
  };

  // Install WordPress helper
  const installWordPress = async (safeName) => {
    const dbPassword = generatePassword();
    const rootPassword = generatePassword();

    // Always find first available ports starting from defaults
    const wpPort = await findNextAvailablePort(parseInt(oneClickForm.wordpressPort) || 7000);
    const dbPort = await findNextAvailablePort(parseInt(oneClickForm.dbPort) || 7001);

    // Update form to show actual ports being used
    setOneClickForm(prev => ({ ...prev, wordpressPort: wpPort.toString(), dbPort: dbPort.toString() }));

    toast({ title: 'Ports Selected', description: `Using WordPress port ${wpPort}, Database port ${dbPort}` });

    // Create directory
    const installDir = `/root/docker/${safeName}`;
    await api.executeCommand(`mkdir -p "${installDir}"`, '/');

    // Create .env file
    const envContent = `# ${oneClickForm.siteName} Environment Variables
WORDPRESS_PORT=${wpPort}
DB_PORT=${dbPort}
DB_ROOT_PASSWORD=${rootPassword}
DB_NAME=wp_${safeName}db
DB_USER=wp_${safeName}user
DB_PASSWORD=${dbPassword}
`;
    await api.writeFile(`${installDir}/.env`, envContent);

    // Create docker-compose.yml with proper networking and health checks
    const composeContent = `version: '3.8'

services:
  wordpress:
    image: wordpress:latest
    container_name: wp_${safeName}_app
    ports:
      - "\${WORDPRESS_PORT}:80"
    environment:
      WORDPRESS_DB_HOST: database:3306
      WORDPRESS_DB_USER: \${DB_USER}
      WORDPRESS_DB_PASSWORD: \${DB_PASSWORD}
      WORDPRESS_DB_NAME: \${DB_NAME}
    volumes:
      - wordpress_data:/var/www/html
    depends_on:
      database:
        condition: service_healthy
    restart: always
    networks:
      - wp_network

  database:
    image: mysql:5.7
    container_name: wp_${safeName}_db
    ports:
      - "\${DB_PORT}:3306"
    environment:
      MYSQL_ROOT_PASSWORD: \${DB_ROOT_PASSWORD}
      MYSQL_DATABASE: \${DB_NAME}
      MYSQL_USER: \${DB_USER}
      MYSQL_PASSWORD: \${DB_PASSWORD}
    volumes:
      - db_data:/var/lib/mysql
    restart: always
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", "-p\${DB_ROOT_PASSWORD}"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 30s
    networks:
      - wp_network

networks:
  wp_network:
    driver: bridge

volumes:
  wordpress_data:
  db_data:
`;
    await api.writeFile(`${installDir}/docker-compose.yml`, composeContent);

    // Start docker compose
    toast({ title: 'Starting Installation', description: 'This may take a minute while MySQL initializes...' });
    const startResult = await api.executeCommand(`cd "${installDir}" && docker compose up -d`, '/', 120000);

    if (!startResult.success) {
      throw new Error(startResult.output || 'Failed to start containers');
    }

    // Wait for MySQL to be healthy (check health status)
    toast({ title: 'Waiting for Database', description: 'Waiting for MySQL to be ready...' });
    let dbReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const healthCheck = await api.executeCommand(`docker inspect --format='{{.State.Health.Status}}' wp_${safeName}_db 2>/dev/null || echo "starting"`, '/');
      if (healthCheck.output?.trim() === 'healthy') {
        dbReady = true;
        break;
      }
    }

    if (!dbReady) {
      toast({ variant: 'destructive', title: 'Warning', description: 'Database may still be initializing. WordPress might need a moment.' });
    }

    // Create ProxyPilot service
    try {
      await api.createService({
        name: oneClickForm.siteName,
        domain: oneClickForm.domain,
        type: 'docker',
        target: '127.0.0.1',
        port: wpPort,
        containerName: `wp_${safeName}_app`,
        sslEnabled: true,
        forceHttps: true,
        websocketEnabled: true,
        maxUploadSize: '100M',
        obtainCertificate: true,
      });
    } catch (e) {
      console.error('Service creation warning:', e);
    }

    toast({
      title: 'WordPress Installed!',
      description: `${oneClickForm.siteName} is now running at ${oneClickForm.domain}`,
    });
  };

  // File Management Functions
  const openEditor = async (service) => {
    setFiles([]);
    setSelectedFile(null);
    setFileContent('');
    setOriginalContent('');
    setVersions([]);
    setShowVersions(false);
    setEditorOpen(true);
    setExpandedDirs({});

    try {
      // Fetch fresh service data to ensure we have the latest path
      const { service: freshService } = await api.getService(service.id);
      setSelectedService(freshService);

      const { files } = await api.getFiles(service.id);
      setFiles(files);
    } catch (error) {
      // Fallback to passed service if fetch fails
      setSelectedService(service);
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load files',
      });
    }
  };

  // Phase 2b I.1: routes card loaders + mutation handlers.
  const loadSettingsRoutes = async (serviceId) => {
    setSettingsRoutesLoading(true);
    try {
      const { routes } = await api.getServiceRoutes(serviceId);
      setSettingsRoutes(routes || []);
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Failed to load routes',
        description: err.message,
      });
      setSettingsRoutes([]);
    } finally {
      setSettingsRoutesLoading(false);
    }
  };

  // Begin inline edit on an existing route row. Seeds the draft form
  // with the row's current values. Phase 2c per-route knobs
  // (stripPrefix / r-w timeouts / hostHeaderOverride) round-trip
  // through the form so existing rows keep their behavior on save.
  const beginEditSettingsRoute = (route) => {
    setEditingRouteId(route.id);
    setEditingRouteDraft({
      domain: route.domain || '',
      pathPrefix: route.pathPrefix || '/',
      targetPort: route.targetPort != null ? String(route.targetPort) : '',
      sslEnabled: route.sslEnabled !== false,
      forceHttps: route.forceHttps !== false,
      websocketEnabled: !!route.websocketEnabled,
      maxUploadSize: route.maxUploadSize || '1G',
      stripPrefix:
        route.stripPrefix == null
          ? (route.pathPrefix && route.pathPrefix !== '/')
          : !!route.stripPrefix,
      readTimeoutSeconds:
        route.readTimeoutSeconds != null
          ? String(route.readTimeoutSeconds)
          : '',
      writeTimeoutSeconds:
        route.writeTimeoutSeconds != null
          ? String(route.writeTimeoutSeconds)
          : '',
      hostHeaderOverride: route.hostHeaderOverride || '',
      allowFraming: !!route.allowFraming,
      frameAncestors: route.frameAncestors || '',
    });
  };

  // Begin inline add — uses the sentinel 'new' so the form lives
  // under the last row instead of replacing one of them.
  const beginAddSettingsRoute = () => {
    setEditingRouteId('new');
    setEditingRouteDraft({
      domain: '',
      pathPrefix: '/',
      targetPort: '',
      sslEnabled: true,
      forceHttps: true,
      websocketEnabled: false,
      maxUploadSize: '1G',
      // New routes default stripPrefix to "follow path_prefix"
      // semantics: strip when there's an explicit prefix, leave
      // alone when matching at root. Operator can flip in the
      // editor for fan-out workloads (MEET-style).
      stripPrefix: false,
      readTimeoutSeconds: '',
      writeTimeoutSeconds: '',
      hostHeaderOverride: '',
      allowFraming: false,
      frameAncestors: '',
    });
  };

  const cancelEditSettingsRoute = () => {
    setEditingRouteId(null);
    setEditingRouteDraft(null);
  };

  // Save either a new or edited route. On success reload the routes
  // list so the card reflects the canonical backend state.
  const saveEditSettingsRoute = async () => {
    if (!settingsService || !editingRouteDraft) return;
    setSavingRoute(true);
    try {
      const body = {
        domain: editingRouteDraft.domain,
        pathPrefix: editingRouteDraft.pathPrefix,
        targetPort: editingRouteDraft.targetPort
          ? parseInt(editingRouteDraft.targetPort, 10)
          : undefined,
        sslEnabled: !!editingRouteDraft.sslEnabled,
        forceHttps: !!editingRouteDraft.forceHttps,
        websocketEnabled: !!editingRouteDraft.websocketEnabled,
        maxUploadSize: editingRouteDraft.maxUploadSize || '1G',
        // Phase 2c knobs. stripPrefix is sent explicitly so the
        // backend stores the operator's choice rather than re-deriving
        // it from path_prefix on every read.
        stripPrefix: !!editingRouteDraft.stripPrefix,
        readTimeoutSeconds: editingRouteDraft.readTimeoutSeconds
          ? parseInt(editingRouteDraft.readTimeoutSeconds, 10)
          : null,
        writeTimeoutSeconds: editingRouteDraft.writeTimeoutSeconds
          ? parseInt(editingRouteDraft.writeTimeoutSeconds, 10)
          : null,
        hostHeaderOverride: editingRouteDraft.hostHeaderOverride
          ? editingRouteDraft.hostHeaderOverride
          : null,
        allowFraming: !!editingRouteDraft.allowFraming,
        frameAncestors: editingRouteDraft.frameAncestors
          ? editingRouteDraft.frameAncestors
          : null,
      };
      if (editingRouteId === 'new') {
        await api.createRoute(settingsService.id, body);
        toast({ title: 'Route added' });
      } else {
        await api.updateRoute(settingsService.id, editingRouteId, body);
        toast({ title: 'Route updated' });
      }
      await loadSettingsRoutes(settingsService.id);
      // Also refresh the top-level services list so the grid card
      // mirrors the new state and the sibling warnings in I.3 are
      // computed off the latest routes.
      fetchServices();
      cancelEditSettingsRoute();
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Failed to save route',
        description: err.message,
      });
    } finally {
      setSavingRoute(false);
    }
  };

  // Phase 2c: per-route advanced knobs (strip-prefix toggle, WS r/w
  // timeouts, host-header override). Returns a JSX fragment so both
  // the inline-edit form and the new-row form can drop it in one
  // place. Reads from `editingRouteDraft` and writes back via
  // `setEditingRouteDraft({ ...editingRouteDraft, ... })`, so the
  // existing form lifecycle (cancel/save/loading) is unchanged.
  const renderRouteAdvancedKnobs = (idPrefix) => {
    if (!editingRouteDraft) return null;
    return (
      <>
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-xs">Strip path prefix</Label>
            <div className="text-xs text-muted-foreground">
              {editingRouteDraft.stripPrefix
                ? 'handle_path: prefix removed before forwarding'
                : 'handle: prefix kept on forwarded request'}
            </div>
          </div>
          <Switch
            checked={!!editingRouteDraft.stripPrefix}
            onCheckedChange={(checked) =>
              setEditingRouteDraft({ ...editingRouteDraft, stripPrefix: checked })
            }
          />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-xs">WebSocket / streaming</Label>
            <div className="text-xs text-muted-foreground">
              Disables response buffering; default timeouts bumped to 24h.
            </div>
          </div>
          <Switch
            checked={!!editingRouteDraft.websocketEnabled}
            onCheckedChange={(checked) =>
              setEditingRouteDraft({ ...editingRouteDraft, websocketEnabled: checked })
            }
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-rt`} className="text-xs">
              Read timeout (s)
            </Label>
            <Input
              id={`${idPrefix}-rt`}
              type="number"
              min="1"
              max="86400"
              value={editingRouteDraft.readTimeoutSeconds || ''}
              onChange={(e) =>
                setEditingRouteDraft({
                  ...editingRouteDraft,
                  readTimeoutSeconds: e.target.value,
                })
              }
              placeholder={editingRouteDraft.websocketEnabled ? '86400' : '60'}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-wt`} className="text-xs">
              Write timeout (s)
            </Label>
            <Input
              id={`${idPrefix}-wt`}
              type="number"
              min="1"
              max="86400"
              value={editingRouteDraft.writeTimeoutSeconds || ''}
              onChange={(e) =>
                setEditingRouteDraft({
                  ...editingRouteDraft,
                  writeTimeoutSeconds: e.target.value,
                })
              }
              placeholder={editingRouteDraft.websocketEnabled ? '86400' : '60'}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-host`} className="text-xs">
            Host header override
          </Label>
          <Input
            id={`${idPrefix}-host`}
            value={editingRouteDraft.hostHeaderOverride || ''}
            onChange={(e) =>
              setEditingRouteDraft({
                ...editingRouteDraft,
                hostHeaderOverride: e.target.value,
              })
            }
            placeholder="(pass through)"
          />
        </div>
        {/* Phase 2c: framing escape hatch. Caddy's `header` directive
            is per-site, so this toggle on any single route on the
            domain flips the whole site to emit -X-Frame-Options +
            Content-Security-Policy: frame-ancestors. Default off:
            most apps want the deny-iframe posture. Required for
            embeddable apps (MEET meeting page, OAuth popups). */}
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-xs">Allow framing (iframe-embeddable)</Label>
            <div className="text-xs text-muted-foreground">
              Site-level: removes X-Frame-Options, adds frame-ancestors CSP.
            </div>
          </div>
          <Switch
            checked={!!editingRouteDraft.allowFraming}
            onCheckedChange={(checked) =>
              setEditingRouteDraft({ ...editingRouteDraft, allowFraming: checked })
            }
          />
        </div>
        {editingRouteDraft.allowFraming && (
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-frame-ancestors`} className="text-xs">
              frame-ancestors (comma-separated, blank = *)
            </Label>
            <Input
              id={`${idPrefix}-frame-ancestors`}
              value={editingRouteDraft.frameAncestors || ''}
              onChange={(e) =>
                setEditingRouteDraft({
                  ...editingRouteDraft,
                  frameAncestors: e.target.value,
                })
              }
              placeholder="* (allow any embedder)"
            />
          </div>
        )}
      </>
    );
  };

  // Delete a route inline from the card. No TOTP dialog — routes are
  // sub-objects and removing one does not destroy the parent service.
  const deleteSettingsRoute = async (route) => {
    if (!settingsService) return;
    setSavingRoute(true);
    try {
      await api.deleteRoute(settingsService.id, route.id);
      toast({ title: 'Route removed' });
      await loadSettingsRoutes(settingsService.id);
      fetchServices();
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Failed to delete route',
        description: err.message,
      });
    } finally {
      setSavingRoute(false);
    }
  };

  // Phase 2b I.2: refresh the cached LXC IP for an LXC-runtime
  // service. Backend E.2 re-queries Incus and regenerates every
  // affected merged Caddy config.
  const handleRefreshLxcIp = async () => {
    if (!settingsService) return;
    setRefreshingLxcIp(true);
    try {
      const res = await api.refreshLxcIp(settingsService.id);
      const oldIp = res?.oldIp ?? settingsService.targetIp ?? '(unknown)';
      const newIp = res?.newIp ?? res?.targetIp ?? '(unchanged)';
      toast({
        title: 'LXC IP refreshed',
        description: `${oldIp} → ${newIp}`,
      });
      // Re-fetch the service so the card reflects the updated IP.
      const { service: fresh } = await api.getService(settingsService.id);
      setSettingsService(fresh);
      fetchServices();
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Refresh IP failed',
        description: err.message,
      });
    } finally {
      setRefreshingLxcIp(false);
    }
  };

  // Service Settings Functions
  const openSettings = async (service) => {
    setSettingsDialogOpen(true);
    setSettingsTab('settings');
    setConfigVersions([]);
    setCaddyConfig('');
    setCaddyConfigOriginal('');
    // Phase 2b I.1: reset any leftover inline-edit state from a
    // previous settings-dialog open.
    cancelEditSettingsRoute();
    setSettingsRoutes([]);

    try {
      // Fetch fresh service data to ensure we have the latest settings
      const { service: freshService } = await api.getService(service.id);
      setSettingsService(freshService);
      setSettingsForm({
        target: freshService.target || '127.0.0.1',
        port: freshService.port || '',
        websocketEnabled: freshService.websocketEnabled || false,
        forceHttps: freshService.forceHttps !== false,
        maxUploadSize: freshService.maxUploadSize || '1G',
        sslEnabled: freshService.sslEnabled !== false,
        rootDir: freshService.rootDir || '',
        dataDir: freshService.dataDir || '',
      });
      // Phase 2b I.1: eagerly load the nested routes alongside the
      // service so the Routes card in the Settings tab renders as
      // soon as the dialog opens.
      loadSettingsRoutes(freshService.id);
    } catch (error) {
      // Fallback to passed service if fetch fails
      setSettingsService(service);
      setSettingsForm({
        target: service.target || '127.0.0.1',
        port: service.port || '',
        websocketEnabled: service.websocketEnabled || false,
        forceHttps: service.forceHttps !== false,
        maxUploadSize: service.maxUploadSize || '1G',
        sslEnabled: service.sslEnabled !== false,
        rootDir: service.rootDir || '',
        dataDir: service.dataDir || '',
      });
      loadSettingsRoutes(service.id);
    }
  };

  // Fetch Caddy config for advanced editing
  const fetchCaddyConfig = async () => {
    if (!settingsService) return;
    setLoadingCaddyConfig(true);
    try {
      const { config } = await api.getCaddyConfig(settingsService.id);
      setCaddyConfig(config);
      setCaddyConfigOriginal(config);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load Caddy config',
      });
    } finally {
      setLoadingCaddyConfig(false);
    }
  };

  // Save Caddy config with failsafe revert
  const saveCaddyConfig = async () => {
    if (!settingsService) return;
    setSavingCaddyConfig(true);
    try {
      await api.saveCaddyConfig(settingsService.id, caddyConfig);
      setCaddyConfigOriginal(caddyConfig);
      toast({
        title: 'Success',
        description: 'Caddy configuration saved and reloaded',
      });
      fetchConfigVersions();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message || 'Failed to save Caddy config',
      });
    } finally {
      setSavingCaddyConfig(false);
    }
  };

  const fetchConfigVersions = async () => {
    if (!settingsService) return;
    setLoadingConfigVersions(true);
    try {
      const { versions } = await api.getConfigVersions(settingsService.id);
      setConfigVersions(versions);
    } catch (error) {
      console.error('Error fetching config versions:', error);
    } finally {
      setLoadingConfigVersions(false);
    }
  };

  const handleRevertConfig = async (versionId, versionNum) => {
    if (!settingsService) return;
    setRevertingVersion(versionId);
    try {
      await api.revertConfig(settingsService.id, versionId);
      toast({
        title: 'Success',
        description: `Reverted to version ${versionNum}`,
      });
      fetchServices();
      fetchConfigVersions();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setRevertingVersion(null);
    }
  };

  const saveSettings = async () => {
    if (!settingsService) return;
    setSavingSettings(true);

    try {
      await api.updateService(settingsService.id, {
        target: settingsForm.target,
        port: settingsForm.port ? parseInt(settingsForm.port, 10) : null,
        websocketEnabled: settingsForm.websocketEnabled,
        forceHttps: settingsForm.forceHttps,
        maxUploadSize: settingsForm.maxUploadSize,
        sslEnabled: settingsForm.sslEnabled,
        rootDir: settingsForm.rootDir || undefined,
        dataDir: settingsForm.dataDir || undefined,
      });
      toast({
        title: 'Success',
        description: 'Service settings saved and Caddy config regenerated',
      });
      setSettingsDialogOpen(false);
      fetchServices();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setSavingSettings(false);
    }
  };

  const toggleDir = (path) => {
    setExpandedDirs(prev => ({
      ...prev,
      [path]: !prev[path],
    }));
  };

  const selectFile = async (file) => {
    if (file.type === 'directory') {
      toggleDir(file.path);
      return;
    }

    setSelectedFile(file);
    setShowVersions(false);
    setVersions([]);
    const lang = getLanguageFromFile(file.name);
    setSelectedLanguage(lang);

    try {
      const { content } = await api.getFileContent(selectedService.id, file.path);
      setFileContent(content);
      setOriginalContent(content);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load file content',
      });
    }
  };

  const saveFile = async () => {
    if (!selectedFile) return;
    setSavingFile(true);

    try {
      const result = await api.saveFile(selectedService.id, selectedFile.path, fileContent, saveNotes || null);
      setOriginalContent(fileContent);
      setSaveNotes('');
      toast({
        title: 'Success',
        description: result.caddyReloaded
          ? 'File saved and Caddy reloaded'
          : 'File saved successfully',
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setSavingFile(false);
    }
  };

  const createNewFile = async () => {
    if (!newFileName.trim()) return;
    setSavingFile(true);

    try {
      await api.saveFile(selectedService.id, newFileName, '');
      toast({
        title: 'Success',
        description: 'File created successfully',
      });
      setNewFileName('');
      setShowNewFileInput(false);

      const { files } = await api.getFiles(selectedService.id);
      setFiles(files);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    } finally {
      setSavingFile(false);
    }
  };

  const deleteFile = async (file, e) => {
    e.stopPropagation();
    if (!confirm(`Delete ${file.name}?`)) return;

    try {
      await api.deleteFile(selectedService.id, file.path);
      toast({
        title: 'Success',
        description: 'File deleted successfully',
      });

      if (selectedFile?.path === file.path) {
        setSelectedFile(null);
        setFileContent('');
      }

      const { files: newFiles } = await api.getFiles(selectedService.id);
      setFiles(newFiles);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    }
  };

  // Version Control Functions
  const loadVersions = async () => {
    if (!selectedFile) return;
    setLoadingVersions(true);

    try {
      const { versions: v } = await api.getFileVersions(selectedService.id, selectedFile.path);
      setVersions(v);
      setShowVersions(true);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load versions',
      });
    } finally {
      setLoadingVersions(false);
    }
  };

  const viewVersion = async (version) => {
    try {
      const { content } = await api.getVersionContent(selectedService.id, version.id);
      setFileContent(content);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load version',
      });
    }
  };

  const revertToVersion = async (version) => {
    if (!confirm(`Revert to version ${version.version}?`)) return;

    try {
      await api.revertToVersion(selectedService.id, version.id);
      const { content } = await api.getFileContent(selectedService.id, selectedFile.path);
      setFileContent(content);
      setOriginalContent(content);
      toast({
        title: 'Success',
        description: `Reverted to version ${version.version}`,
      });
      loadVersions();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    }
  };

  const updateVersionNotes = async (version) => {
    try {
      await api.updateVersionNotes(selectedService.id, version.id, noteText);
      setEditingNotes(null);
      setNoteText('');
      toast({
        title: 'Success',
        description: 'Notes updated',
      });
      loadVersions();
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error.message,
      });
    }
  };

  const startEditingNotes = (version) => {
    setEditingNotes(version.id);
    setNoteText(version.notes || '');
  };

  // File Import/Export in editor
  const exportFiles = async () => {
    try {
      const data = await api.exportServiceFiles(selectedService.id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selectedService.name.replace(/\s+/g, '-').toLowerCase()}-files.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: 'Success', description: 'Files exported' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
    }
  };

  const importFiles = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.files || !Array.isArray(data.files)) {
        throw new Error('Invalid file format');
      }

      const result = await api.importServiceFiles(selectedService.id, data.files);
      toast({
        title: 'Import Complete',
        description: `Imported: ${result.results.imported.length}, Errors: ${result.results.errors.length}`,
      });

      const { files } = await api.getFiles(selectedService.id);
      setFiles(files);
    } catch (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
    }

    e.target.value = '';
  };

  // Upload files directly to service data directory
  const uploadFilesToService = async (e) => {
    const uploadedFiles = e.target.files;
    if (!uploadedFiles || uploadedFiles.length === 0 || !selectedService) return;

    let successCount = 0;
    let errorCount = 0;

    for (const file of uploadedFiles) {
      try {
        const reader = new FileReader();
        const base64Content = await new Promise((resolve, reject) => {
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        await api.uploadFile(selectedService.id, file.name, base64Content, 'base64');
        successCount++;
      } catch (err) {
        errorCount++;
      }
    }

    toast({
      title: 'Upload Complete',
      description: `Uploaded: ${successCount}${errorCount ? `, Failed: ${errorCount}` : ''}`,
    });

    // Refresh file list
    try {
      const { files: updatedFiles } = await api.getFiles(selectedService.id);
      setFiles(updatedFiles);
    } catch (e) { /* ignore */ }

    e.target.value = '';
  };

  // Export/Import Functions
  const handleExport = async () => {
    setSubmitting(true);
    try {
      const data = await api.exportServices(exportServiceIds, exportIncludeFiles);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `proxypilot-export-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setExportDialogOpen(false);
      toast({ title: 'Success', description: 'Export downloaded successfully' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleImport = async () => {
    setSubmitting(true);
    try {
      const data = JSON.parse(importData);
      if (!data.services || !Array.isArray(data.services)) {
        throw new Error('Invalid import data format');
      }
      const result = await api.importServices(data.services, importOverwrite);
      setImportDialogOpen(false);
      setImportData('');
      fetchServices();
      // Also refresh terminal file browser if terminal is open (force refresh to ensure UI updates)
      if (terminalOpen) {
        fetchTerminalDirectory(terminalCwd, true);
      }
      toast({
        title: 'Import Complete',
        description: `Imported: ${result.results.imported.length}, Skipped: ${result.results.skipped.length}`,
      });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Error', description: error.message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => setImportData(e.target.result);
      reader.readAsText(file);
    }
  };

  const toggleExportService = (serviceId) => {
    setExportServiceIds(prev =>
      prev.includes(serviceId)
        ? prev.filter(id => id !== serviceId)
        : [...prev, serviceId]
    );
  };

  const getServiceIcon = (type) => {
    switch (type) {
      case 'proxy':
        return <Server className="h-5 w-5 text-orange-500" />;
      case 'static':
        return <FolderOpen className="h-5 w-5 text-blue-500" />;
      case 'docker':
        return <Container className="h-5 w-5 text-purple-500" />;
      default:
        return <Globe className="h-5 w-5 text-green-500" />;
    }
  };

  const getServiceLocation = (service) => {
    switch (service.type) {
      case 'proxy':
        return `${service.target || '127.0.0.1'}:${service.port}`;
      case 'static':
        return service.rootDir || service.dataDir;
      case 'docker':
        return service.containerName;
      default:
        return '-';
    }
  };

  // Get directory path for opening terminal
  const getServiceDirectory = (service) => {
    switch (service.type) {
      case 'static':
        return service.rootDir || service.dataDir || '/';
      case 'docker':
        // Try to derive from container name pattern (wp_sitename_app -> /root/docker/sitename)
        if (service.containerName?.startsWith('wp_') && service.containerName?.endsWith('_app')) {
          const siteName = service.containerName.slice(3, -4);
          return `/root/docker/${siteName}`;
        }
        return service.dataDir || '/root/docker';
      default:
        return '/';
    }
  };

  const renderFileTree = (items, depth = 0) => {
    return items.map((item) => (
      <div key={item.path} className="group">
        <div
          className={`flex items-center gap-2 py-1 px-2 cursor-pointer hover:bg-muted rounded ${
            selectedFile?.path === item.path ? 'bg-muted' : ''
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => selectFile(item)}
        >
          {item.type === 'directory' ? (
            <>
              {expandedDirs[item.path] ? (
                <ChevronDown className="h-4 w-4 shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0" />
              )}
              <Folder className="h-4 w-4 shrink-0 text-yellow-500" />
            </>
          ) : (
            <>
              <span className="w-4" />
              <File className="h-4 w-4 shrink-0 text-muted-foreground" />
            </>
          )}
          <span className="text-sm truncate flex-1">{item.name}</span>
          {item.type === 'file' && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 opacity-0 group-hover:opacity-100"
              onClick={(e) => deleteFile(item, e)}
            >
              <Trash2 className="h-3 w-3 text-destructive" />
            </Button>
          )}
        </div>
        {item.type === 'directory' && expandedDirs[item.path] && item.children && (
          renderFileTree(item.children, depth + 1)
        )}
      </div>
    ));
  };

  const hasUnsavedChanges = fileContent !== originalContent;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Route drift banner. Cross-tenant findings are their own, louder block:
          a hostname served from another project's guest is a containment
          problem, not a availability one, and must not be mixed in with
          ordinary staleness. */}
      {routeDrift && (!routeDrift.clean || routeDrift.unreserved?.length > 0) && (
        <div className="space-y-3">
          {routeDrift.cross_tenant?.length > 0 && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-semibold text-red-400">
                    <ShieldAlert className="h-4 w-4 shrink-0" />
                    <span>
                      {routeDrift.cross_tenant.length} route
                      {routeDrift.cross_tenant.length === 1 ? '' : 's'} served from another container
                    </span>
                  </div>
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {routeDrift.cross_tenant.map((x) => (
                      <li key={x.domain} className="break-words">
                        <span className="font-mono">{x.domain}</span> is declared against{' '}
                        <span className="font-mono">{x.declared_container}</span> but the edge dials{' '}
                        <span className="font-mono">{x.upstream}</span>, which belongs to{' '}
                        <span className="font-mono">{x.serving_container}</span>.
                      </li>
                    ))}
                  </ul>
                </div>
                <Button
                  variant="outline"
                  className="min-h-[44px] shrink-0"
                  onClick={handleRegenerateAllConfigs}
                  disabled={regeneratingAll}
                >
                  {regeneratingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Regenerate configs'}
                </Button>
              </div>
            </div>
          )}
          {(routeDrift.summary?.drift > 0 || routeDrift.summary?.missing_in_caddy > 0) && (
            <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-semibold text-yellow-500">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <span>Caddy does not match the route table</span>
                  </div>
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {routeDrift.domains
                      .filter((d) => d.status === 'drift' || d.status === 'missing_in_caddy')
                      .map((d) => (
                        <li key={d.domain} className="break-words">
                          <span className="font-mono">{d.domain}</span> — {(d.differences || []).join('; ')}
                        </li>
                      ))}
                  </ul>
                  {!routeDrift.caddy_admin_reachable && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Caddy's admin API was unreachable; compared against the site files only.
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  className="min-h-[44px] shrink-0"
                  onClick={handleRegenerateAllConfigs}
                  disabled={regeneratingAll}
                >
                  {regeneratingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Regenerate configs'}
                </Button>
              </div>
            </div>
          )}
          {routeDrift.unreserved?.length > 0 && (
            <div className="rounded-lg border border-border bg-muted/40 p-4">
              <div className="flex items-start gap-2 text-sm">
                <Info className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
                <p className="text-muted-foreground break-words">
                  {routeDrift.unreserved.length} route
                  {routeDrift.unreserved.length === 1 ? '' : 's'} point at a container with no
                  static address reservation, so a DHCP lease renewal can move it:{' '}
                  <span className="font-mono">
                    {[...new Set(routeDrift.unreserved.map((u) => u.container))].join(', ')}
                  </span>
                  . Pin the address on the container's network settings to remove the risk.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">Services</h1>
          <p className="text-muted-foreground">
            Manage your proxy services and domains
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={handleReloadCaddy} title="Reload Caddy">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            onClick={handleRegenerateAllConfigs}
            disabled={regeneratingAll}
            title="Regenerate All Caddy Configs"
          >
            {regeneratingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          </Button>
          <Button variant="outline" onClick={() => { setExportServiceIds([]); setExportDialogOpen(true); }}>
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
          <Button variant="outline" onClick={() => { setImportData(''); setImportDialogOpen(true); }}>
            <Upload className="h-4 w-4 mr-2" />
            Import
          </Button>
          <Button variant="outline" onClick={() => { setDiscoverDialogOpen(true); discoverSites(); }}>
            <Radar className="h-4 w-4 mr-2" />
            Discover
          </Button>
          {isAdmin && (
            <Button variant="outline" onClick={() => openTerminal()}>
              <Terminal className="h-4 w-4 mr-2" />
              Terminal
            </Button>
          )}
          <Button
            variant="outline"
            className="text-green-600 border-green-600 hover:bg-green-600/10"
            onClick={async () => {
              setOneClickDialogOpen(true);
              setOneClickService(null);
              // Auto-detect available ports
              const wpPort = await findNextAvailablePort(7000);
              const dbPort = await findNextAvailablePort(wpPort + 1);
              setOneClickForm(prev => ({
                ...prev,
                wordpressPort: wpPort.toString(),
                dbPort: dbPort.toString(),
              }));
            }}
            title="One-Click Install Services"
          >
            <Rocket className="h-4 w-4 mr-2" />
            One-Click
          </Button>
          <div className="relative hidden md:block">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 w-9 p-0"
              onClick={() => setNotifOpen(!notifOpen)}
              title="Notifications"
            >
              <Bell className="h-4 w-4" />
            </Button>
            {notifOpen && (
              <div className="absolute right-0 top-10 z-50 w-[min(20rem,calc(100vw-2rem))] max-h-96 overflow-y-auto border rounded-lg bg-background shadow-lg">
                <div className="flex items-center justify-between p-3 border-b">
                  <h4 className="text-sm font-medium">Notifications</h4>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setNotifOpen(false)}>
                    <X className="h-3 w-3" />
                  </Button>
                </div>
                {getNotificationHistory().length === 0 ? (
                  <p className="p-4 text-xs text-muted-foreground text-center">No notifications yet</p>
                ) : (
                  <div className="divide-y">
                    {getNotificationHistory().map((n) => (
                      <div key={n.id} className={`p-3 text-xs ${n.variant === 'destructive' ? 'border-l-2 border-l-red-500' : ''}`}>
                        <div className="font-medium">{n.title}</div>
                        {n.description && <div className="text-muted-foreground mt-0.5">{n.description}</div>}
                        <div className="text-muted-foreground/60 mt-1">{n.timestamp.toLocaleTimeString()}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <Button
            variant="outline"
            className="text-red-500 border-red-500 hover:bg-red-500/10"
            onClick={() => { setTotpCode(''); setKillSwitchDialogOpen(true); }}
            title="Secure/Shutdown ProxyPilot"
          >
            <ShieldAlert className="h-4 w-4 mr-2" />
            Kill Switch
          </Button>
          <Dialog open={addDialogOpen} onOpenChange={(open) => { setAddDialogOpen(open); if (!open) resetForm(); }}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Service
              </Button>
            </DialogTrigger>
            <DialogContent className={wizardStep === 0 ? "max-w-full h-full rounded-none sm:max-w-2xl sm:h-auto sm:rounded-lg" : "max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg"}>
              <DialogHeader>
                <DialogTitle>Add New Service</DialogTitle>
                <DialogDescription>
                  {wizardStep === 0 ? 'Select the type of service to create' : 'Configure your service details'}
                </DialogDescription>
              </DialogHeader>

              {wizardStep === 0 ? (
                /*
                 * Phase 2b post-H.1 follow-up: four-tile Step 0 picker
                 * restoring the at-a-glance choice of the original
                 * pre-H.1 picker (Static Site / Docker Container / LXC
                 * Container / Docker Compose). Each tile pre-fills both
                 * `kind` and `runtime` via handleStep0Tile so the H.2
                 * runtime sub-step is skipped on the normal path; the
                 * sub-step still exists in Step 1 as a defensive fallback
                 * for any flow that lands there with runtime=null. The
                 * Compose tile closes the dialog and switches to the
                 * Compose tab — compose stack creation lives there, not
                 * inside Add Service, since Phase 2b's data model treats
                 * a service as one container + N HTTP routes.
                 */
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-4">
                  <Card
                    data-testid="wizard-tile-static-site"
                    className="cursor-pointer hover:border-primary transition-colors"
                    onClick={() => handleStep0Tile('static_site')}
                  >
                    <CardHeader className="text-center pb-2">
                      <FolderOpen className="h-12 w-12 mx-auto text-primary" />
                      <CardTitle className="text-lg">Static Site</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription className="text-center">
                        Serve static HTML, CSS, and JavaScript from a local directory.
                      </CardDescription>
                    </CardContent>
                  </Card>
                  <Card
                    data-testid="wizard-tile-docker"
                    className="cursor-pointer hover:border-primary transition-colors"
                    onClick={() => handleStep0Tile('docker')}
                  >
                    <CardHeader className="text-center pb-2">
                      <Container className="h-12 w-12 mx-auto text-primary" />
                      <CardTitle className="text-lg">Docker Container</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription className="text-center">
                        Reverse-proxy HTTP routes to a Docker container by IP and port.
                      </CardDescription>
                    </CardContent>
                  </Card>
                  <Card
                    data-testid="wizard-tile-lxc"
                    className="cursor-pointer hover:border-primary transition-colors"
                    onClick={() => handleStep0Tile('lxc')}
                  >
                    <CardHeader className="text-center pb-2">
                      <Server className="h-12 w-12 mx-auto text-primary" />
                      <CardTitle className="text-lg">LXC Container</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription className="text-center">
                        Reverse-proxy HTTP routes to an existing Incus / LXC container.
                      </CardDescription>
                    </CardContent>
                  </Card>
                  {/* Docker Compose tile intentionally removed.
                      ProxyPilot now recommends running Docker
                      inside an LXC ('docker-in-LXC') and exposing
                      services via the Docker Container or LXC
                      Container tile above instead of running a
                      compose stack on the host directly.  Existing
                      compose stacks are still discoverable via
                      api.discoverDockerCompose so an operator can
                      pick up a service from a running stack
                      without re-creating it here. */}
                </div>
              ) : (
                <form onSubmit={handleAddService} className="space-y-4">
                  <div className="flex items-center gap-2 p-2 bg-muted rounded mb-4">
                    {formData.kind === 'static_site' ? (
                      <FolderOpen className="h-5 w-5 text-primary" />
                    ) : formData.runtime === 'lxc' ? (
                      <Server className="h-5 w-5 text-primary" />
                    ) : (
                      <Container className="h-5 w-5 text-primary" />
                    )}
                    <span className="font-medium">
                      {formData.kind === 'static_site'
                        ? 'Static Site'
                        : formData.runtime === 'lxc'
                          ? 'LXC Container'
                          : formData.runtime === 'docker'
                            ? 'Docker Container'
                            : 'Container Service'}
                    </span>
                    <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setWizardStep(0)}>Change</Button>
                  </div>

                  {/*
                   * Phase 2b H.2: runtime + LXC-container sub-step. Only
                   * renders for `kind='container_service'`. Static sites
                   * skip this entirely and fall through to the form tail.
                   * Until a runtime is picked (and — for LXC — a container
                   * is chosen) the rest of the form is hidden via the
                   * `formReady` gate below.
                   */}
                  {formData.kind === 'container_service' && (
                    <>
                      {formData.runtime === null ? (
                        <div className="space-y-2">
                          <Label>Runtime</Label>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
                            <Card
                              data-testid="wizard-runtime-lxc"
                              className="cursor-pointer hover:border-primary transition-colors"
                              onClick={() => handleRuntimeSelect('lxc')}
                            >
                              <CardHeader className="text-center pb-2">
                                <svg className="h-10 w-10 mx-auto text-cyan-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                                  <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                                  <line x1="12" y1="22.08" x2="12" y2="12"/>
                                </svg>
                                <CardTitle className="text-base">LXC Container</CardTitle>
                              </CardHeader>
                              <CardContent className="pb-3">
                                <CardDescription className="text-center text-xs">
                                  Proxy to an Incus-managed system container.
                                </CardDescription>
                              </CardContent>
                            </Card>
                            <Card
                              data-testid="wizard-runtime-docker"
                              className="cursor-pointer hover:border-primary transition-colors"
                              onClick={() => handleRuntimeSelect('docker')}
                            >
                              <CardHeader className="text-center pb-2">
                                <Container className="h-10 w-10 mx-auto text-primary" />
                                <CardTitle className="text-base">Docker Container</CardTitle>
                              </CardHeader>
                              <CardContent className="pb-3">
                                <CardDescription className="text-center text-xs">
                                  Proxy to an existing Docker container by name + port.
                                </CardDescription>
                              </CardContent>
                            </Card>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 p-2 bg-muted/50 rounded">
                          <span className="text-xs text-muted-foreground">Runtime:</span>
                          <span className="font-medium text-sm uppercase">{formData.runtime}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="ml-auto"
                            data-testid="wizard-runtime-change"
                            onClick={handleRuntimeChange}
                          >
                            Change
                          </Button>
                        </div>
                      )}

                      {formData.runtime === 'lxc' && !formData.lxcContainerName && (
                        <div data-testid="wizard-lxc-container-picker" className="space-y-2">
                          <Label htmlFor="lxcContainerPicker">LXC Container</Label>
                          {lxcWizardLoading ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground p-3 bg-muted/50 rounded">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Loading containers…
                            </div>
                          ) : lxcWizardError ? (
                            <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-300">
                              Failed to load LXC containers: {lxcWizardError}
                            </div>
                          ) : lxcWizardContainers.length === 0 ? (
                            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-300">
                              No LXC containers found. Create one from the LXC tab first.
                            </div>
                          ) : (
                            <Select onValueChange={handleLxcContainerSelect}>
                              <SelectTrigger id="lxcContainerPicker">
                                <SelectValue placeholder="Pick a container…" />
                              </SelectTrigger>
                              <SelectContent>
                                {lxcWizardContainers.map((c) => (
                                  <SelectItem key={c.name} value={c.name}>
                                    {c.name}
                                    {c.ipv4 ? ` — ${c.ipv4}` : ' (no IPv4)'}
                                    {c.status ? ` (${c.status.toLowerCase()})` : ''}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          )}
                          <p className="text-xs text-muted-foreground">
                            The container's cached IPv4 address is stored on the service.
                            Use Refresh IP on the service detail page if the container IP changes.
                          </p>
                        </div>
                      )}

                      {formData.runtime === 'lxc' && formData.lxcContainerName && (
                        <div data-testid="wizard-lxc-container-summary" className="p-3 bg-muted/50 rounded space-y-1 text-sm">
                          <p>
                            <span className="text-muted-foreground">Container:</span>{' '}
                            <code className="font-mono">{formData.lxcContainerName}</code>
                          </p>
                          <p>
                            <span className="text-muted-foreground">Target IP:</span>{' '}
                            <code className="font-mono">{formData.targetIp || '(not set)'}</code>
                          </p>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 px-2 text-xs"
                            onClick={() =>
                              setFormData((f) => ({
                                ...f,
                                lxcContainerName: '',
                                targetIp: '',
                                target: '127.0.0.1',
                                containerName: '',
                              }))
                            }
                          >
                            Change container
                          </Button>
                        </div>
                      )}
                    </>
                  )}

                  {/*
                   * Phase 2b H.2: form tail gate. `formReady` is true for
                   * static sites unconditionally, for container_service +
                   * docker runtime as soon as the runtime tile is tapped
                   * (containerName/target/port are collected below), and
                   * for container_service + lxc runtime once the operator
                   * has picked a container from the dropdown. The gate
                   * hides the tail plus the Create button so the wizard
                   * cannot be submitted with an incomplete runtime pick.
                   */}
                  {(
                    formData.kind === 'static_site' ||
                    (formData.kind === 'container_service' && formData.runtime === 'docker') ||
                    (formData.kind === 'container_service' && formData.runtime === 'lxc' && !!formData.lxcContainerName)
                  ) && (
                  <>
                  <div className="space-y-2">
                    <Label htmlFor="name">Service Name</Label>
                    <Input id="name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="My Application" required />
                  </div>
                  {formData.kind === 'container_service' && formData.runtime === 'docker' && (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="containerName">Container Name</Label>
                        <Input id="containerName" value={formData.containerName} onChange={(e) => setFormData({ ...formData, containerName: e.target.value })} placeholder="my-container" required />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="target">IP Address</Label>
                        <Input
                          id="target"
                          value={formData.target}
                          onChange={(e) => setFormData({ ...formData, target: e.target.value })}
                          placeholder="127.0.0.1"
                          pattern="^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^localhost$"
                          title="Enter a valid IP address (e.g., 127.0.0.1) or localhost"
                        />
                        <p className="text-xs text-muted-foreground">Default: localhost (127.0.0.1)</p>
                      </div>
                    </>
                  )}
                  {formData.kind === 'static_site' && (
                    <div className="space-y-2">
                      <Label htmlFor="rootDir">Root Directory</Label>
                      <Input
                        id="rootDir"
                        value={formData.rootDir}
                        onChange={(e) => setFormData({ ...formData, rootDir: e.target.value })}
                        placeholder="/var/www/mysite (leave empty to auto-create)"
                      />
                      <p className="text-xs text-muted-foreground">
                        Directory containing the site files. Leave blank and ProxyPilot will
                        create one under <code>/data/services</code>.
                      </p>
                    </div>
                  )}

                  {/*
                   * Phase 2b H.3: routes builder. Each row carries its own
                   * (domain, pathPrefix, targetPort, sslEnabled) tuple. The
                   * trash icon removes the row — disabled on the last
                   * remaining row so the form always has at least one
                   * route. The Add Route button appends a new empty row.
                   * Layout stacks at <sm via flex-col and inlines at sm+
                   * per MOBILE_FIRST.md §4. Trash + add buttons hit the
                   * 44x44 touch target on mobile per MOBILE_FIRST.md §5.
                   * Static Site skips the Port column since routes just
                   * point at the service's rootDir, not a port.
                   */}
                  <div className="space-y-3" data-testid="wizard-routes-builder">
                    <div className="flex items-center justify-between">
                      <Label>HTTP Routes</Label>
                      <span className="text-xs text-muted-foreground">
                        {formData.routes.length} route{formData.routes.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    {formData.routes.map((route, i) => (
                      <div
                        key={route.id}
                        data-testid={`wizard-route-row-${i}`}
                        className="rounded-md border p-3 space-y-3"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                          <div className="flex-1 space-y-1 min-w-0">
                            <Label htmlFor={`route-domain-${i}`} className="text-xs">Domain</Label>
                            <Input
                              id={`route-domain-${i}`}
                              data-testid={`wizard-route-domain-${i}`}
                              value={route.domain}
                              onChange={(e) => updateWizardRoute(i, { domain: e.target.value })}
                              placeholder="app.example.com"
                              required
                            />
                          </div>
                          <div className="flex-1 space-y-1 min-w-0">
                            <Label htmlFor={`route-prefix-${i}`} className="text-xs">Path Prefix</Label>
                            <Input
                              id={`route-prefix-${i}`}
                              data-testid={`wizard-route-prefix-${i}`}
                              value={route.pathPrefix}
                              onChange={(e) => updateWizardRoute(i, { pathPrefix: e.target.value })}
                              placeholder="/"
                              pattern="^/(?:[a-zA-Z0-9._~\-]+(?:/[a-zA-Z0-9._~\-]+)*/?)?$"
                              title="Must start with / and contain only URL-safe characters"
                            />
                          </div>
                          {formData.kind === 'container_service' && (
                            <div className="w-full sm:w-28 space-y-1">
                              <Label htmlFor={`route-port-${i}`} className="text-xs">Port</Label>
                              <Input
                                id={`route-port-${i}`}
                                data-testid={`wizard-route-port-${i}`}
                                type="number"
                                value={route.targetPort}
                                onChange={(e) => updateWizardRoute(i, { targetPort: e.target.value })}
                                placeholder="3000"
                                min="1"
                                max="65535"
                                required
                              />
                            </div>
                          )}
                          <div className="flex items-center justify-end sm:self-end gap-1 shrink-0">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-11 w-11 sm:h-10 sm:w-10 text-red-500 hover:text-red-600"
                              data-testid={`wizard-route-remove-${i}`}
                              onClick={() => removeWizardRoute(i)}
                              disabled={formData.routes.length <= 1}
                              title={formData.routes.length <= 1 ? 'At least one route is required' : 'Remove route'}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                        <div className="flex items-center justify-between">
                          <div>
                            <Label htmlFor={`route-ssl-${i}`} className="text-xs">SSL enabled</Label>
                            <p className="text-xs text-muted-foreground">HTTPS with an auto-obtained certificate.</p>
                          </div>
                          <Switch
                            id={`route-ssl-${i}`}
                            data-testid={`wizard-route-ssl-${i}`}
                            checked={!!route.sslEnabled}
                            onCheckedChange={(checked) => updateWizardRoute(i, { sslEnabled: checked })}
                          />
                        </div>
                        {/*
                         * Phase 2b H.4: per-row "existing prefixes" banner.
                         * Looks up the lowercase-normalized domain the
                         * operator typed against the global
                         * existingPrefixesByDomain map (flattened from
                         * every service's routes). Surfaces immediately
                         * when the domain has any existing prefix across
                         * any service so the operator sees the conflict
                         * before they click Create.
                         */}
                        {(() => {
                          const key = (route.domain || '').toLowerCase().trim();
                          if (!key) return null;
                          const existing = existingPrefixesByDomain.get(key);
                          if (!existing || existing.length === 0) return null;
                          return (
                            <div
                              data-testid={`wizard-existing-prefixes-${i}`}
                              className="rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-xs text-blue-600 dark:text-blue-300"
                            >
                              Domain already in use. Existing path prefixes:{' '}
                              <code className="font-mono">{existing.join(', ')}</code>.
                              Choose a different prefix to add another route on this domain.
                            </div>
                          );
                        })()}
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="wizard-route-add"
                      onClick={addWizardRoute}
                      className="h-11 sm:h-10"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Add route
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="maxUploadSize">Max Upload Size</Label>
                    <Input id="maxUploadSize" value={formData.maxUploadSize} onChange={(e) => setFormData({ ...formData, maxUploadSize: e.target.value })} placeholder="1G" />
                    <p className="text-xs text-muted-foreground">Applied to every route on this service.</p>
                  </div>
                  {formData.routes.some((r) => r.sslEnabled) && (
                    <div className="flex items-center justify-between pl-4 border-l-2 border-primary/20">
                      <div>
                        <Label htmlFor="obtainCertificate">Auto-obtain Certificate</Label>
                        <p className="text-xs text-muted-foreground">Caddy will auto-obtain a certificate via ACME for every SSL-enabled route.</p>
                      </div>
                      <Switch id="obtainCertificate" checked={formData.obtainCertificate} onCheckedChange={(checked) => setFormData({ ...formData, obtainCertificate: checked })} />
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <Label htmlFor="forceHttps">Force HTTPS</Label>
                    <Switch id="forceHttps" checked={formData.forceHttps} onCheckedChange={(checked) => setFormData({ ...formData, forceHttps: checked })} />
                  </div>
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setAddDialogOpen(false)}>Cancel</Button>
                    <Button type="submit" disabled={submitting}>
                      {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating...</> : 'Create Service'}
                    </Button>
                  </DialogFooter>
                  </>
                  )}
                  {/* Phase 2b H.2: Cancel button still reachable even when
                      the form tail is gated off, so an operator who
                      accidentally opened the wizard can close it without
                      completing the runtime pick. */}
                  {!(
                    formData.kind === 'static_site' ||
                    (formData.kind === 'container_service' && formData.runtime === 'docker') ||
                    (formData.kind === 'container_service' && formData.runtime === 'lxc' && !!formData.lxcContainerName)
                  ) && (
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={() => setAddDialogOpen(false)}>Cancel</Button>
                    </DialogFooter>
                  )}
                </form>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Dashboard Tabs.
          Compose tab intentionally hidden: ProxyPilot is steering
          operators toward the docker-in-LXC pattern (run a Docker
          daemon inside an LXC, manage HTTP routes via the standard
          Add Service wizard).  The discovery / 'pick up an
          already-running compose service' path stays in the API
          (api.discoverDockerCompose) so existing stacks can still
          surface as services, but creating new compose stacks
          from this dashboard is no longer encouraged. */}
      <div className="flex flex-col gap-2 border-b pb-2 sm:flex-row sm:items-center">
        <div className="flex gap-1 p-1 bg-muted rounded-lg flex-nowrap overflow-x-auto max-w-full">
          <Button
            variant={dashboardTab === 'resources' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setDashboardTab('resources')}
            className="gap-2 shrink-0"
          >
            <Activity className="h-4 w-4" />
            Resources
          </Button>
          <Button
            variant={dashboardTab === 'services' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setDashboardTab('services')}
            className="gap-2 shrink-0"
          >
            <LayoutGrid className="h-4 w-4" />
            Services
          </Button>
          <Button
            variant={dashboardTab === 'lxc' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setDashboardTab('lxc')}
            className="gap-2 shrink-0"
          >
            <Box className="h-4 w-4" />
            LXC
          </Button>
        </div>
        <div className="sm:ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Default view:</span>
          <select
            className="text-xs border rounded px-2 py-1 bg-background"
            value={localStorage.getItem('dashboardDefaultTab') || 'resources'}
            onChange={(e) => {
              localStorage.setItem('dashboardDefaultTab', e.target.value);
              toast({ title: 'Preference saved', description: `Default view set to ${e.target.value}` });
            }}
          >
            <option value="resources">Resources</option>
            <option value="services">Services</option>
            <option value="lxc">LXC</option>
          </select>
        </div>
      </div>

      {/* Resources View - System Stats */}
      {dashboardTab === 'resources' && (
        <div className="space-y-4">
          {statsLoading && !systemStats ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : systemStats ? (
            <>
              {/* System Uptime */}
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4" />
                System uptime: {Math.floor(systemStats.uptime / 86400)}d {Math.floor((systemStats.uptime % 86400) / 3600)}h {Math.floor((systemStats.uptime % 3600) / 60)}m
              </div>

              {/* Stats Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* CPU Usage */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Cpu className="h-4 w-4 text-blue-500" />
                      CPU Usage
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-3xl font-bold text-blue-500">
                      {systemStats.cpu.usage.toFixed(1)}%
                    </div>
                    <div className="mt-2 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 transition-all duration-500"
                        style={{ width: `${Math.min(systemStats.cpu.usage, 100)}%` }}
                      />
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      Load: {systemStats.load.avg1.toFixed(2)} / {systemStats.load.avg5.toFixed(2)} / {systemStats.load.avg15.toFixed(2)}
                    </div>
                  </CardContent>
                </Card>

                {/* Memory Usage */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <MemoryStick className="h-4 w-4 text-green-500" />
                      Memory
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-3xl font-bold text-green-500">
                      {systemStats.memory.usagePercent}%
                    </div>
                    <div className="mt-2 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500 transition-all duration-500"
                        style={{ width: `${systemStats.memory.usagePercent}%` }}
                      />
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {(systemStats.memory.used / 1024 / 1024 / 1024).toFixed(1)} GB / {(systemStats.memory.total / 1024 / 1024 / 1024).toFixed(1)} GB
                    </div>
                  </CardContent>
                </Card>

                {/* Disk Usage */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <HardDrive className="h-4 w-4 text-orange-500" />
                      Disk Usage
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-3xl font-bold text-orange-500">
                      {systemStats.disk.usagePercent}%
                    </div>
                    <div className="mt-2 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-orange-500 transition-all duration-500"
                        style={{ width: `${systemStats.disk.usagePercent}%` }}
                      />
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {(systemStats.disk.used / 1024 / 1024 / 1024).toFixed(1)} GB / {(systemStats.disk.total / 1024 / 1024 / 1024).toFixed(1)} GB
                    </div>
                  </CardContent>
                </Card>

              </div>

              {/* Quick Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-blue-500/10 rounded-lg">
                      <Container className="h-5 w-5 text-blue-500" />
                    </div>
                    <div>
                      <div className="text-2xl font-bold">{services.length}</div>
                      <div className="text-xs text-muted-foreground">Services</div>
                    </div>
                  </div>
                </Card>
                <Card className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-green-500/10 rounded-lg">
                      <FolderTree className="h-5 w-5 text-green-500" />
                    </div>
                    <div>
                      <div className="text-2xl font-bold">{Object.keys(serviceFolders).length}</div>
                      <div className="text-xs text-muted-foreground">Folders</div>
                    </div>
                  </div>
                </Card>
                <Card className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-orange-500/10 rounded-lg">
                      <Package className="h-5 w-5 text-orange-500" />
                    </div>
                    <div>
                      <div className="text-2xl font-bold">{composeServices.length}</div>
                      <div className="text-xs text-muted-foreground">Compose Stacks</div>
                    </div>
                  </div>
                </Card>
                <Card className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-yellow-500/10 rounded-lg">
                      <Star className="h-5 w-5 text-yellow-500" />
                    </div>
                    <div>
                      <div className="text-2xl font-bold">{services.filter(s => s.isFavorite).length}</div>
                      <div className="text-xs text-muted-foreground">Favorites</div>
                    </div>
                  </div>
                </Card>
              </div>
            </>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              Failed to load system stats. Retrying...
            </div>
          )}
        </div>
      )}

      {/* Services View */}
      {dashboardTab === 'services' && (
        <>
      {/* Search/Filter/Sort Bar */}
      <div className="flex flex-wrap gap-3 items-center bg-muted/50 p-3 rounded-lg">
        <div className="flex-1 min-w-[200px] relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search services..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-full sm:w-[140px]">
            <Filter className="h-4 w-4 mr-2" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="static">Static</SelectItem>
            <SelectItem value="docker">Docker</SelectItem>
            <SelectItem value="proxy">Proxy</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sortBy} onValueChange={setSortBy}>
          <SelectTrigger className="w-full sm:w-[140px]">
            <SortAsc className="h-4 w-4 mr-2" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="favorite">Favorites First</SelectItem>
            <SelectItem value="name">Name</SelectItem>
            <SelectItem value="domain">Domain</SelectItem>
            <SelectItem value="type">Type</SelectItem>
            <SelectItem value="newest">Newest</SelectItem>
            <SelectItem value="oldest">Oldest</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant={showFavoritesOnly ? 'default' : 'outline'}
          size="sm"
          onClick={() => setShowFavoritesOnly(!showFavoritesOnly)}
        >
          <Star className={`h-4 w-4 mr-1 ${showFavoritesOnly ? 'fill-current' : ''}`} />
          Favorites
        </Button>
        <div className="flex items-center gap-1 border rounded-md p-1">
          <Button
            variant={viewMode === 'grid' ? 'default' : 'ghost'}
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setViewMode('grid')}
            title="Grid View"
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === 'list' ? 'default' : 'ghost'}
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setViewMode('list')}
            title="List View"
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
        <span className="text-sm text-muted-foreground">
          {filteredServices.length} service{filteredServices.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Main Content with Folder Sidebar */}
      <div className="flex flex-col md:flex-row gap-4">
        {/* Left Sidebar - Folder Navigation (collapsible on mobile) */}
        <div className="w-full md:w-56 md:shrink-0">
          <div className="border rounded-lg md:sticky md:top-4">
            <div className="p-3 border-b bg-muted/50 flex items-center justify-between">
              <button
                type="button"
                className="flex-1 flex items-center justify-between gap-2 text-left md:cursor-default"
                onClick={() => setMobileFoldersOpen((v) => !v)}
                aria-expanded={mobileFoldersOpen}
              >
                <span className="font-medium text-sm flex items-center gap-2">
                  <FolderTree className="h-4 w-4" />
                  Folders
                  <span className="md:hidden text-xs text-muted-foreground">
                    ({services.length} total)
                  </span>
                </span>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 md:hidden transition-transform shrink-0",
                    mobileFoldersOpen ? "rotate-180" : "rotate-0"
                  )}
                />
              </button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 ml-2 shrink-0"
                onClick={() => {
                  setNewFolderName('');
                  setSelectedParentFolder(null);
                  setFolderDialogOpen(true);
                }}
                title="Create new folder"
              >
                <FolderPlus className="h-4 w-4" />
              </Button>
            </div>
            <div
              className={cn(
                "p-2 space-y-1",
                mobileFoldersOpen ? "block" : "hidden",
                "md:block"
              )}
            >
              {/* All Services */}
              <div
                className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm ${selectedFolderFilter === null ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                onClick={() => setSelectedFolderFilter(null)}
              >
                <LayoutGrid className="h-4 w-4" />
                <span>All Services</span>
                <span className="ml-auto text-xs opacity-70">{services.length}</span>
              </div>

              {/* Unfoldered - Drop zone to remove from folders */}
              <div
                className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm transition-colors ${
                  selectedFolderFilter === '' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                } ${dragOverFolder === 'unfoldered' ? 'ring-2 ring-primary ring-offset-1' : ''}`}
                onClick={() => setSelectedFolderFilter('')}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverFolder('unfoldered');
                }}
                onDragLeave={() => setDragOverFolder(null)}
                onDrop={handleRootDrop}
              >
                <File className="h-4 w-4" />
                <span>Unfoldered</span>
                <span className="ml-auto text-xs opacity-70">
                  {services.filter(s => !Object.values(serviceFolders).some(f => f.services?.includes(s.id))).length}
                </span>
              </div>

              {/* Folder List with Nested Support */}
              {Object.entries(serviceFolders).length > 0 && (
                <div className="border-t my-2 pt-2">
                  {(() => {
                    // Recursive folder renderer
                    const renderFolder = (folderPath, folder, depth = 0) => {
                      const folderServiceCount = folder.services?.length || 0;
                      const isSelected = selectedFolderFilter === folderPath;
                      const isExpanded = expandedFolders[folderPath];
                      const subfolders = getSubfolders(folderPath);
                      const hasSubfolders = subfolders.length > 0;
                      const isDragOver = dragOverFolder === folderPath;
                      const showDropBefore = folderDropPosition?.folderPath === folderPath && folderDropPosition?.position === 'before';
                      const showDropAfter = folderDropPosition?.folderPath === folderPath && folderDropPosition?.position === 'after';

                      return (
                        <div key={folderPath} className="relative">
                          {/* Drop indicator line - before */}
                          {showDropBefore && (
                            <div
                              className="absolute left-0 right-0 h-0.5 bg-primary rounded-full z-10"
                              style={{ top: 0, marginLeft: `${depth * 12 + 8}px` }}
                            />
                          )}
                          <div
                            draggable
                            onDragStart={(e) => handleFolderDragStart(e, folderPath)}
                            onDragEnd={handleFolderDragEnd}
                            onDragOver={(e) => handleFolderDragOver(e, folderPath)}
                            onDragLeave={handleFolderDragLeave}
                            onDrop={(e) => handleFolderDrop(e, folderPath)}
                            className={`group flex items-center gap-1 px-2 py-1.5 rounded cursor-grab text-sm transition-colors ${
                              isSelected ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                            } ${isDragOver ? 'ring-2 ring-primary ring-offset-1' : ''} ${draggedFolder === folderPath ? 'opacity-50' : ''}`}
                            style={{ paddingLeft: `${depth * 12 + 8}px` }}
                            onClick={() => setSelectedFolderFilter(folderPath)}
                          >
                            {hasSubfolders ? (
                              <button
                                className="p-0.5 -ml-1 hover:bg-muted rounded"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedFolders(prev => ({ ...prev, [folderPath]: !prev[folderPath] }));
                                }}
                              >
                                {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                              </button>
                            ) : (
                              <span className="w-4" />
                            )}
                            <GripVertical className="h-3 w-3 opacity-0 group-hover:opacity-50 cursor-grab" />
                            <Folder className={`h-4 w-4 ${isSelected ? '' : 'text-yellow-500'}`} />
                            <span className="truncate flex-1">{folder.name}</span>
                            <span className="text-xs opacity-70">{folderServiceCount}</span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className={`h-5 w-5 p-0 opacity-0 group-hover:opacity-100 ${isSelected ? 'text-primary-foreground hover:text-primary/70' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedParentFolder(folderPath);
                                setNewFolderName('');
                                setFolderDialogOpen(true);
                              }}
                              title="Add subfolder"
                            >
                              <FolderPlus className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className={`h-5 w-5 p-0 opacity-0 group-hover:opacity-100 ${isSelected ? 'text-primary-foreground hover:text-red-300' : 'text-red-500'}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteFolder(folderPath);
                                if (isSelected) setSelectedFolderFilter(null);
                              }}
                              title="Delete folder"
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                          {/* Drop indicator line - after */}
                          {showDropAfter && (
                            <div
                              className="absolute left-0 right-0 h-0.5 bg-primary rounded-full z-10"
                              style={{ bottom: 0, marginLeft: `${depth * 12 + 8}px` }}
                            />
                          )}
                          {isExpanded && subfolders.map(([subPath, subFolder]) =>
                            renderFolder(subPath, subFolder, depth + 1)
                          )}
                        </div>
                      );
                    };

                    // Render root folders
                    return getRootFolders().map(([path, folder]) => renderFolder(path, folder));
                  })()}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Services Grid/List */}
        <div className="flex-1">
          <div className={viewMode === 'grid' ? 'grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3' : 'space-y-2'}>
            {/*
              Phase 2b J.1: generalize the domain-grouped header to
              route-derived domains. Phase 2 assumed one service owns
              one (domain, path_prefix) tuple and grouped by
              service.domain. After Phase 2b a service can touch
              multiple domains via its nested routes array, so the
              grouping flattens every service into its
              (service, route) pairs first, then groups by
              route.domain, then emits a header above each domain
              that has ≥2 DISTINCT services. Each service card may
              appear under multiple headers (once per domain its
              routes touch); single-service single-domain layouts
              still stay headerless. The Phase 2 favorite-sort order
              is preserved because the flatten walks `filteredServices`
              in its existing order and the Map insertion order
              mirrors that walk.
            */}
            {(() => {
              if (sortBy !== 'favorite') {
                return filteredServices.map((service) => renderServiceCard(service));
              }
              const normalize = (d) => (d || '').toLowerCase().trim();

              // Flatten every service into (service, domain) pairs
              // via its nested routes array (or its legacy top-level
              // domain for pre-Phase-2b installs). A service that has
              // two routes on the same domain contributes once to
              // that domain's bucket — we de-dupe per-service inside
              // the same domain to match "distinct services" counting.
              // Services that contribute zero domains (e.g. a row in
              // the services table with no rows in service_http_routes
              // and no synthesized top-level `domain` after D.14)
              // are tracked in `unplaced` and rendered in a fallback
              // bucket at the end so they can never silently disappear
              // from the grid.
              const groups = new Map();
              const unplaced = [];
              for (const s of filteredServices) {
                const svcDomains = new Set();
                if (Array.isArray(s.routes) && s.routes.length > 0) {
                  for (const r of s.routes) {
                    const d = normalize(r.domain);
                    if (d) svcDomains.add(d);
                  }
                }
                if (svcDomains.size === 0 && s.domain) {
                  svcDomains.add(normalize(s.domain));
                }
                if (svcDomains.size === 0) {
                  unplaced.push(s);
                  continue;
                }
                for (const d of svcDomains) {
                  const arr = groups.get(d) || [];
                  arr.push(s);
                  groups.set(d, arr);
                }
              }

              const out = [];
              const emittedSolo = new Set();
              for (const [domain, list] of groups) {
                if (list.length >= 2) {
                  out.push(
                    <div
                      key={`group-${domain}`}
                      data-testid="domain-group-header"
                      className="col-span-1 sm:col-span-2 lg:col-span-3 mt-2 first:mt-0 flex items-center gap-2 text-xs font-medium text-muted-foreground"
                    >
                      <Globe className="h-3 w-3" />
                      <span>
                        {list.length} services on{' '}
                        <span className="font-mono">{domain}</span>
                      </span>
                    </div>
                  );
                  // Wrap each card in a Fragment keyed on the
                  // (domain, service.id) pair so a service that
                  // appears under multiple domain headers can render
                  // multiple times without tripping React's duplicate-
                  // key warning. The inner Card's own key stays the
                  // service id so any per-card state (drag handles,
                  // etc) keeps its identity across re-renders.
                  for (const s of list) {
                    out.push(
                      <Fragment key={`card-${domain}-${s.id}`}>
                        {renderServiceCard(s)}
                      </Fragment>
                    );
                  }
                } else {
                  // Single-service bucket: only emit the card the
                  // FIRST time we see it so services with routes on
                  // multiple headerless domains do not render twice.
                  for (const s of list) {
                    if (emittedSolo.has(s.id)) continue;
                    emittedSolo.add(s.id);
                    out.push(
                      <Fragment key={`card-solo-${s.id}`}>
                        {renderServiceCard(s)}
                      </Fragment>
                    );
                  }
                }
              }
              // Orphan pass: any service that contributed zero domain
              // buckets above (no routes, no fallback `s.domain`)
              // renders here under an "Unrouted" header. Without this
              // pass these services would be in `filteredServices` (so
              // the counter ticks them up) but never appear in the
              // grid — invisible to the operator.
              if (unplaced.length > 0) {
                out.push(
                  <div
                    key="group-unrouted"
                    data-testid="domain-group-header"
                    className="col-span-1 sm:col-span-2 lg:col-span-3 mt-2 first:mt-0 flex items-center gap-2 text-xs font-medium text-muted-foreground"
                  >
                    <Globe className="h-3 w-3" />
                    <span>
                      {unplaced.length} unrouted service{unplaced.length === 1 ? '' : 's'}
                    </span>
                  </div>
                );
                for (const s of unplaced) {
                  out.push(
                    <Fragment key={`card-unrouted-${s.id}`}>
                      {renderServiceCard(s)}
                    </Fragment>
                  );
                }
              }
              return out;
            })()}

            {filteredServices.length === 0 && (
              <div className="col-span-full text-center py-12 text-muted-foreground">
                <Globe className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>{searchQuery || filterType !== 'all' || showFavoritesOnly || selectedFolderFilter !== null ? 'No services match your filters.' : 'No services configured yet.'}</p>
                <p className="text-sm">
                  {searchQuery || filterType !== 'all' || showFavoritesOnly || selectedFolderFilter !== null
                    ? 'Try adjusting your search or filters.'
                    : 'Click "Add Service" to create your first site.'}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
        </>
      )}

      {/* Compose View - Docker Compose Services */}
      {dashboardTab === 'compose' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Boxes className="h-5 w-5" />
              Docker Compose Services
            </h2>
            <Button variant="outline" size="sm" onClick={fetchComposeServices}>
              <RefreshCw className="h-4 w-4 mr-1" />
              Refresh
            </Button>
          </div>

          {/* Search/Filter/Sort Bar for Compose */}
          <div className="flex flex-wrap gap-3 items-center bg-muted/50 p-3 rounded-lg mb-4">
            <div className="flex-1 min-w-[200px] relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search compose projects..."
                value={composeSearchQuery}
                onChange={(e) => setComposeSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={composeStatusFilter} onValueChange={setComposeStatusFilter}>
              <SelectTrigger className="w-full sm:w-[130px]">
                <Filter className="h-4 w-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="running">Running</SelectItem>
                <SelectItem value="stopped">Stopped</SelectItem>
              </SelectContent>
            </Select>
            <Select value={composeSortBy} onValueChange={setComposeSortBy}>
              <SelectTrigger className="w-full sm:w-[140px]">
                <SortAsc className="h-4 w-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="containers">Containers</SelectItem>
                <SelectItem value="status">Status</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">
              {groupedComposeProjects.length} project{groupedComposeProjects.length !== 1 ? 's' : ''}
            </span>
          </div>
          {groupedComposeProjects.length > 0 && (
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {groupedComposeProjects.map((project) => (
              <Card key={project.projectName} className="border-dashed border-purple-500/30">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className={`w-3 h-3 rounded-full shrink-0 ${project.isRunning ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
                      <Boxes className="h-4 w-4 text-purple-500 shrink-0" />
                      <CardTitle className="text-lg truncate">{project.projectName}</CardTitle>
                    </div>
                    {/* Hot command buttons */}
                    <div className="flex gap-1 flex-wrap justify-end">
                      {/* Start/Stop button */}
                      {project.isRunning ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-9 w-9 sm:h-7 sm:w-7 p-0 text-yellow-500 hover:text-yellow-600"
                          onClick={() => handleComposeAction('stop', project)}
                          disabled={composeActionLoading[`${project.projectName}-stop`]}
                          title="Stop"
                        >
                          {composeActionLoading[`${project.projectName}-stop`] ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Square className="h-4 w-4" />
                          )}
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-9 w-9 sm:h-7 sm:w-7 p-0 text-green-500 hover:text-green-600"
                          onClick={() => handleComposeAction('start', project)}
                          disabled={composeActionLoading[`${project.projectName}-start`]}
                          title="Start"
                        >
                          {composeActionLoading[`${project.projectName}-start`] ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Play className="h-4 w-4" />
                          )}
                        </Button>
                      )}
                      {/* Restart button */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 w-9 sm:h-7 sm:w-7 p-0 text-blue-500 hover:text-blue-600"
                        onClick={() => handleComposeAction('restart', project)}
                        disabled={composeActionLoading[`${project.projectName}-restart`]}
                        title="Restart"
                      >
                        {composeActionLoading[`${project.projectName}-restart`] ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RotateCw className="h-4 w-4" />
                        )}
                      </Button>
                      {/* Destroy button */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 w-9 sm:h-7 sm:w-7 p-0 text-red-500 hover:text-red-600"
                        onClick={() => openDestroyDialog(project)}
                        title="Destroy"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                      {/* Terminal button (Admin only) */}
                      {isAdmin && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-9 w-9 sm:h-7 sm:w-7 p-0"
                          onClick={() => {
                            const firstService = project.services[0];
                            const composeDir = firstService?.composeDir || `/root/docker/${project.projectName}`;
                            openTerminal(composeDir);
                          }}
                          title="Open Terminal"
                        >
                          <Terminal className="h-4 w-4" />
                        </Button>
                      )}
                      {/* Expand/Collapse button */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-9 w-9 sm:h-7 sm:w-7 p-0"
                        onClick={() => setExpandedProjects(prev => ({ ...prev, [project.projectName]: !prev[project.projectName] }))}
                      >
                        {expandedProjects[project.projectName] ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                  <CardDescription>
                    {project.services.length} container{project.services.length !== 1 ? 's' : ''} • {project.isRunning ? 'Running' : 'Stopped'}
                  </CardDescription>
                </CardHeader>
                {expandedProjects[project.projectName] && (
                  <CardContent className="space-y-3">
                    {project.services.map((svc) => {
                      const existingService = services.find(s => s.port === svc.exposedPort && s.type === 'docker');
                      return (
                        <div key={svc.id} className="border rounded-lg p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className={`w-2 h-2 rounded-full ${svc.isRunning ? 'bg-green-500' : 'bg-gray-400'}`} />
                              <Container className="h-3 w-3 text-purple-400" />
                              <span className="font-medium text-sm">{svc.serviceName || svc.containerName}</span>
                            </div>
                          </div>
                          <div className="text-xs text-muted-foreground space-y-1">
                            <div className="flex justify-between">
                              <span>Image:</span>
                              <span className="font-mono truncate max-w-[120px]" title={svc.image}>{svc.image?.split(':')[0]}</span>
                            </div>
                            <div className="flex justify-between">
                              <span>Port:</span>
                              <span className={svc.exposedPort ? 'text-green-500' : ''}>{svc.exposedPort || 'N/A'}</span>
                            </div>
                          </div>
                          {existingService ? (
                            <div className="text-xs text-green-500 flex items-center gap-1">
                              <Check className="h-3 w-3" />
                              Proxied via {existingService.domain}
                            </div>
                          ) : svc.exposedPort ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="w-full h-7 text-xs"
                              onClick={() => {
                                // Phase 2b H.3: seed a single-row routes
                                // array alongside the legacy mirror
                                // fields so the wizard lands ready-to-
                                // submit under the new shape.
                                setFormData({
                                  name: svc.serviceName || svc.containerName,
                                  kind: 'container_service',
                                  runtime: 'docker',
                                  lxcContainerName: '',
                                  targetIp: '127.0.0.1',
                                  routes: [
                                    {
                                      id: pp2bRouteUid(),
                                      domain: '',
                                      pathPrefix: '/',
                                      targetPort: svc.exposedPort.toString(),
                                      sslEnabled: true,
                                    },
                                  ],
                                  rootDir: '',
                                  domain: '',
                                  pathPrefix: '/',
                                  type: 'docker',
                                  target: '127.0.0.1',
                                  port: svc.exposedPort.toString(),
                                  containerName: svc.containerName,
                                  sslEnabled: true,
                                  forceHttps: true,
                                  websocketEnabled: false,
                                  maxUploadSize: '1G',
                                  obtainCertificate: true,
                                });
                                setWizardStep(1);
                                setAddDialogOpen(true);
                              }}
                            >
                              <Plus className="h-3 w-3 mr-1" />
                              Create Proxy
                            </Button>
                          ) : null}
                        </div>
                      );
                    })}
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
          )}

          {groupedComposeProjects.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Boxes className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No Docker Compose services running.</p>
              <p className="text-sm">Use the "One-Click" button to deploy WordPress or create a docker-compose.yml.</p>
            </div>
          )}
        </div>
      )}

      {dashboardTab === 'lxc' && (
        <LxcContainers />
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Delete Service</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Are you sure you want to delete &quot;{serviceToDelete?.name}&quot;? Enter your TOTP code to confirm.
                </p>
                {(() => {
                  // Phase 2b I.3: generalize the sibling-warning to
                  // count every route across every service that lives
                  // on any domain the service-to-delete owns a route
                  // on, minus routes owned by the service-to-delete
                  // itself. A single service can now touch multiple
                  // domains, so the warning may name multiple domains
                  // — each domain appears once regardless of how many
                  // sibling routes exist on it, and its sibling count
                  // is shown in parentheses after the domain.
                  if (!serviceToDelete) return null;

                  const normalize = (d) => (d || '').toLowerCase().trim();

                  // Collect the set of domains this service-to-delete
                  // owns a route on, using the nested routes array
                  // first and the legacy top-level domain as fallback
                  // for pre-Phase-2b installs that have not been
                  // migrated yet.
                  const ownDomains = new Set();
                  if (Array.isArray(serviceToDelete.routes) && serviceToDelete.routes.length > 0) {
                    for (const r of serviceToDelete.routes) {
                      const d = normalize(r.domain);
                      if (d) ownDomains.add(d);
                    }
                  } else if (serviceToDelete.domain) {
                    ownDomains.add(normalize(serviceToDelete.domain));
                  }
                  if (ownDomains.size === 0) return null;

                  // For each of the service-to-delete's domains, count
                  // the surviving sibling routes (every route on that
                  // domain across every OTHER service).
                  const siblingByDomain = new Map();
                  for (const svc of services) {
                    if (svc.id === serviceToDelete.id) continue;
                    const svcRoutes = Array.isArray(svc.routes) && svc.routes.length > 0
                      ? svc.routes.map((r) => ({ domain: normalize(r.domain) }))
                      : svc.domain
                      ? [{ domain: normalize(svc.domain) }]
                      : [];
                    for (const r of svcRoutes) {
                      if (!ownDomains.has(r.domain)) continue;
                      siblingByDomain.set(r.domain, (siblingByDomain.get(r.domain) || 0) + 1);
                    }
                  }

                  // If no sibling routes exist on any affected domain,
                  // suppress the warning entirely.
                  if (siblingByDomain.size === 0) return null;

                  const totalSiblings = [...siblingByDomain.values()].reduce(
                    (a, b) => a + b,
                    0
                  );
                  const domainSummary = [...siblingByDomain.entries()]
                    .map(([domain, count]) => `${domain} (${count})`)
                    .join(', ');

                  return (
                    <p data-testid="delete-sibling-warning" className="text-amber-600 dark:text-amber-400">
                      This will leave {totalSiblings} other route{totalSiblings === 1 ? '' : 's'}{' '}
                      on{' '}
                      <code className="font-mono">{domainSummary}</code>
                      .
                    </p>
                  );
                })()}
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <PasskeyConfirmButton
              hasPasskey={typeof window !== 'undefined' && localStorage.getItem('pp_has_passkey') === 'true'}
              onAssertion={(assertion) => handleDeleteService(assertion)}
              disabled={submitting}
              className="w-full"
            />
            <div className="space-y-2">
              <Label htmlFor="deleteTotp">TOTP Code</Label>
              <Input id="deleteTotp" value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="Enter 6-digit code" maxLength={6} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => handleDeleteService()} disabled={totpCode.length !== 6 || submitting}>
              {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Deleting...</> : 'Delete Service'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Certificate Confirmation Dialog */}
      <Dialog open={removeCertDialogOpen} onOpenChange={setRemoveCertDialogOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Remove SSL Certificate</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove the SSL certificate for "{serviceToRemoveCert?.domain}"?
              This will disable HTTPS for this service. Enter your TOTP code to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <PasskeyConfirmButton
              hasPasskey={typeof window !== 'undefined' && localStorage.getItem('pp_has_passkey') === 'true'}
              onAssertion={(assertion) => confirmRemoveCertificate(assertion)}
              disabled={submitting}
              className="w-full"
            />
            <div className="space-y-2">
              <Label htmlFor="removeCertTotp">TOTP Code</Label>
              <Input
                id="removeCertTotp"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter 6-digit code"
                maxLength={6}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveCertDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => confirmRemoveCertificate()} disabled={totpCode.length !== 6 || submitting}>
              {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Removing...</> : 'Remove Certificate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Docker Compose Destroy Dialog */}
      <Dialog open={destroyDialogOpen} onOpenChange={setDestroyDialogOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle className="text-red-500 flex items-center gap-2">
              <Trash2 className="h-5 w-5" />
              Destroy Compose Project
            </DialogTitle>
            <DialogDescription>
              This will stop and remove the "{projectToDestroy?.projectName}" project. Choose cleanup options:
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Remove Volumes</Label>
                  <p className="text-xs text-muted-foreground">Delete all data stored in volumes</p>
                </div>
                <Switch
                  checked={destroyOptions.removeVolumes}
                  onCheckedChange={(checked) => setDestroyOptions(prev => ({ ...prev, removeVolumes: checked }))}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>Remove Images</Label>
                  <p className="text-xs text-muted-foreground">Delete downloaded container images</p>
                </div>
                <Switch
                  checked={destroyOptions.removeImages}
                  onCheckedChange={(checked) => setDestroyOptions(prev => ({ ...prev, removeImages: checked }))}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>Remove Orphans</Label>
                  <p className="text-xs text-muted-foreground">Remove containers not defined in compose file</p>
                </div>
                <Switch
                  checked={destroyOptions.removeOrphans}
                  onCheckedChange={(checked) => setDestroyOptions(prev => ({ ...prev, removeOrphans: checked }))}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label>System Prune</Label>
                  <p className="text-xs text-muted-foreground">Clean up unused Docker resources</p>
                </div>
                <Switch
                  checked={destroyOptions.prune}
                  onCheckedChange={(checked) => setDestroyOptions(prev => ({ ...prev, prune: checked }))}
                />
              </div>
            </div>
            <div className="space-y-2 pt-2 border-t">
              <PasskeyConfirmButton
                hasPasskey={typeof window !== 'undefined' && localStorage.getItem('pp_has_passkey') === 'true'}
                onAssertion={(assertion) => handleDestroyProject(assertion)}
                disabled={destroyingProject}
                className="w-full"
              />
              <Label htmlFor="destroyTotp">TOTP Code</Label>
              <Input
                id="destroyTotp"
                value={destroyTotpCode}
                onChange={(e) => setDestroyTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter 6-digit code"
                maxLength={6}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDestroyDialogOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => handleDestroyProject()}
              disabled={destroyTotpCode.length !== 6 || destroyingProject}
            >
              {destroyingProject ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Destroying...</>
              ) : (
                'Destroy Project'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Docker Compose Create Dialog */}
      <Dialog open={composeCreateOpen} onOpenChange={setComposeCreateOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-4xl sm:h-[90vh] sm:rounded-lg flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Boxes className="h-5 w-5 text-purple-500" />
              Create Docker Compose Service
            </DialogTitle>
            <DialogDescription>
              Define your docker-compose.yml and start the containers
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col flex-1 min-h-0 gap-4 overflow-hidden">
            <div className="space-y-2 shrink-0">
              <Label htmlFor="composeServiceName">Service Name</Label>
              <Input
                id="composeServiceName"
                value={composeCreateForm.serviceName}
                onChange={(e) => setComposeCreateForm(prev => ({ ...prev, serviceName: e.target.value }))}
                placeholder="my-app"
              />
              <p className="text-xs text-muted-foreground">
                Folder will be created at: /root/docker/{composeCreateForm.serviceName?.toLowerCase().replace(/\s+/g, '-') || 'my-app'}
              </p>
            </div>
            <div className="flex flex-col flex-1 min-h-0 space-y-2">
              <Label>docker-compose.yml</Label>
              <div className="border rounded-md overflow-hidden flex-1 min-h-0">
                <CodeMirror
                  value={composeCreateForm.composeContent}
                  height="100%"
                  extensions={[yaml()]}
                  theme={oneDark}
                  onChange={(value) => setComposeCreateForm(prev => ({ ...prev, composeContent: value }))}
                  className="h-full"
                />
              </div>
            </div>

            {/* Environment Variables Section */}
            <div className="space-y-2 border-t pt-4 shrink-0">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Environment Variables (.env)
                </Label>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.accept = '.env,text/plain';
                      input.onchange = (e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          const reader = new FileReader();
                          reader.onload = (ev) => importEnvFile(ev.target?.result || '');
                          reader.readAsText(file);
                        }
                      };
                      input.click();
                    }}
                  >
                    <Upload className="h-3 w-3 mr-1" />
                    Import .env
                  </Button>
                  <Button variant="outline" size="sm" onClick={addEnvVar}>
                    <Plus className="h-3 w-3 mr-1" />
                    Add Variable
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Use placeholders: <code className="bg-muted px-1 rounded">{'{password}'}</code> for secure password, <code className="bg-muted px-1 rounded">{'{hex}'}</code> for hex string, <code className="bg-muted px-1 rounded">{'{jwt}'}</code> for JWT secret
              </p>
              {composeCreateForm.envVars.length > 0 && (
                <div className="space-y-2 max-h-32 overflow-y-auto">
                  {composeCreateForm.envVars.map((env, index) => (
                    <div key={index} className="flex flex-col sm:flex-row gap-2 sm:items-center">
                      <Input
                        placeholder="KEY"
                        value={env.key}
                        onChange={(e) => updateEnvVar(index, 'key', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                        className="w-full sm:w-1/3 font-mono text-sm"
                      />
                      <span className="text-muted-foreground hidden sm:inline">=</span>
                      <div className="flex gap-2 items-center">
                        <Input
                          placeholder="value or {password}"
                          value={env.value}
                          onChange={(e) => updateEnvVar(index, 'value', e.target.value)}
                          className="flex-1 font-mono text-sm"
                        />
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-red-500 shrink-0" onClick={() => removeEnvVar(index)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => setComposeCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={handleCreateCompose}
              disabled={composeCreating || !composeCreateForm.serviceName.trim()}
            >
              {composeCreating ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating...</>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" />
                  Create & Start
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Terminal Dialog */}
      <Dialog open={terminalOpen} onOpenChange={setTerminalOpen}>
        <DialogContent className={`max-w-full h-full rounded-none ${terminalFullscreen ? 'sm:max-w-[100vw] sm:w-screen sm:h-screen sm:max-h-screen sm:m-0 sm:rounded-none' : 'sm:max-w-5xl sm:h-[85vh] sm:rounded-lg'} flex flex-col overflow-hidden`}>
          <DialogHeader className="shrink-0">
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle className="flex items-center gap-2">
                  <Terminal className="h-5 w-5" />
                  Host Terminal
                  <span className="text-xs font-normal text-muted-foreground ml-2">{terminalCwd}</span>
                </DialogTitle>
                <DialogDescription>
                  Execute commands on the host system
                  {systemInfo?.hostname ? ` - ${systemInfo.hostname}` : ''}
                </DialogDescription>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={refreshContainers} title="Refresh containers">
                  <RefreshCw className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={() => setTerminalFullscreen(!terminalFullscreen)} title="Toggle fullscreen">
                  {terminalFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </DialogHeader>

          <div className={`flex ${terminalFullscreen ? 'flex-row' : 'flex-col md:flex-row'} gap-4 flex-1 min-h-0 overflow-hidden`}>
            {/* Left Panel: File Browser + Docker Containers
                Desktop: always visible as a sidebar (w-64 / w-72 when fullscreen).
                Mobile: full-width, and only visible when the bottom tab bar has
                'files' selected — otherwise hidden so Terminal/Editor get the
                entire dialog real estate. */}
            <div
              className={cn(
                // Width: full on mobile, fixed sidebar on desktop
                terminalFullscreen ? 'w-full md:w-72' : 'w-full md:w-64',
                'flex-col gap-2 min-h-0',
                // Mobile: take the full available vertical space when active
                terminalActiveTab === 'files' ? 'flex flex-1' : 'hidden',
                // Desktop: always visible, don't grow/shrink
                'md:flex md:flex-none'
              )}
            >
              {/* Current View - File Browser */}
              <div className="border rounded flex flex-col flex-1 min-h-0">
                <div className="p-2 border-b bg-muted shrink-0 flex items-center justify-between">
                  <span className="font-medium text-sm flex items-center gap-2">
                    <FolderTree className="h-4 w-4" />
                    Current View
                  </span>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => {
                        setTerminalInitialCwd(terminalCwd);
                        setTerminalActiveTab('terminal');
                      }}
                      title={`Open terminal in ${terminalCwd}`}
                    >
                      <Terminal className="h-3 w-3" />
                    </Button>
                    <label>
                      <input type="file" multiple className="hidden" onChange={handleTerminalFileUpload} />
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0" asChild title="Upload files to current folder">
                        <span><Upload className="h-3 w-3" /></span>
                      </Button>
                    </label>
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => fetchTerminalDirectory(terminalCwd, true)}>
                      <RefreshCw className={`h-3 w-3 ${loadingTerminalFiles ? 'animate-spin' : ''}`} />
                    </Button>
                  </div>
                </div>
                <div className="px-2 py-1 text-xs font-mono text-muted-foreground bg-muted/50 border-b truncate" title={terminalCwd}>
                  {terminalCwd}
                </div>
                <div className="flex-1 overflow-auto p-1">
                  {loadingTerminalFiles ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin" />
                    </div>
                  ) : terminalFiles.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-2">Empty directory</p>
                  ) : (
                    <div className="space-y-0.5">
                      {terminalCwd !== '/' && (
                        <div
                          className="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-muted cursor-pointer text-xs"
                          onDoubleClick={async () => {
                            const parentDir = terminalCwd.split('/').slice(0, -1).join('/') || '/';
                            setTerminalCwd(parentDir);
                            fetchTerminalDirectory(parentDir);
                            fetchComposeContainersForDir(parentDir);
                            setTerminalOutput(prev => [...prev, { type: 'system', text: `Changed directory to: ${parentDir}` }]);
                          }}
                        >
                          <Folder className="h-3 w-3 text-blue-400" />
                          <span className="text-muted-foreground">..</span>
                        </div>
                      )}
                      {terminalFiles.map((item) => (
                        <div
                          key={item.name}
                          className="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-muted cursor-pointer text-xs"
                          onDoubleClick={async () => {
                            if (item.isDir) {
                              const newPath = `${terminalCwd}/${item.name}`.replace(/\/+/g, '/');
                              setTerminalCwd(newPath);
                              fetchTerminalDirectory(newPath);
                              fetchComposeContainersForDir(newPath);
                              setTerminalOutput(prev => [...prev, { type: 'system', text: `Changed directory to: ${newPath}` }]);
                            } else {
                              // Open file in editor tab
                              const fullPath = `${terminalCwd}/${item.name}`.replace(/\/+/g, '/');
                              openFileInEditor(fullPath);
                            }
                          }}
                          title={`${item.perms} ${item.size}`}
                        >
                          {item.isDir ? (
                            <Folder className="h-3 w-3 text-blue-400" />
                          ) : (
                            <File className="h-3 w-3 text-gray-400" />
                          )}
                          <span className={item.isDir ? 'text-blue-400' : ''}>{item.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Docker Containers Panel */}
              <div className="border rounded flex flex-col flex-1 min-h-0">
                <div className="p-2 border-b bg-muted shrink-0">
                  <span className="font-medium text-sm flex items-center gap-2">
                    <Container className="h-4 w-4" />
                    Docker Containers
                  </span>
                </div>
                <div className="flex-1 overflow-auto p-2 space-y-2">
                  {containers.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">No containers found</p>
                  ) : (
                    containers.map((container) => (
                      <div key={container.id} className="border rounded p-2 text-xs space-y-1">
                        <div className="font-medium truncate" title={container.name}>{container.name}</div>
                        <div className="text-muted-foreground truncate" title={container.image}>{container.image}</div>
                        <div className={`${container.status?.includes('Up') ? 'text-green-500' : 'text-red-500'}`}>
                          {container.status}
                        </div>
                        <div className="flex gap-1 pt-1">
                          {container.status?.includes('Up') ? (
                            <>
                              <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => handleContainerAction('stop', container)}>
                                <Square className="h-3 w-3" />
                              </Button>
                              <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => handleContainerAction('restart', container)}>
                                <RotateCw className="h-3 w-3" />
                              </Button>
                            </>
                          ) : (
                            <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => handleContainerAction('start', container)}>
                              <Play className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            {/* Terminal/Editor Tabbed Panel
                Desktop: always visible; mobile: hidden when 'files' tab is
                selected so the file browser takes the full dialog. */}
            <div
              className={cn(
                'flex-1 flex-col border rounded min-h-0',
                terminalActiveTab === 'files' ? 'hidden' : 'flex',
                'md:flex'
              )}
            >
              {/* Tab Bar (hidden on mobile — the bottom tab bar below handles
                  switching between Files / Terminal / Editor). */}
              <div className="hidden md:flex border-b bg-muted shrink-0">
                <button
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    terminalActiveTab === 'terminal'
                      ? 'border-primary text-primary bg-background'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => setTerminalActiveTab('terminal')}
                >
                  <Terminal className="h-4 w-4 inline-block mr-2" />
                  Terminal
                </button>
                <button
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    terminalActiveTab === 'editor'
                      ? 'border-primary text-primary bg-background'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={() => setTerminalActiveTab('editor')}
                >
                  <Code className="h-4 w-4 inline-block mr-2" />
                  Editor
                  {editorFilePath && editorContent !== editorOriginalContent && (
                    <span className="ml-1 text-yellow-500">●</span>
                  )}
                </button>
              </div>

              {/* Terminal Tab Content — live PTY over WebSocket. Kept
                  mounted (toggled with `hidden`) so the session
                  survives tab switches between Terminal and Editor. */}
              <div
                className={cn(
                  'flex-1 flex flex-col min-h-0 overflow-hidden',
                  terminalActiveTab !== 'terminal' && 'hidden'
                )}
              >
                {terminalOpen && (
                  <InteractiveTerminal
                    wsPath="/api/terminal/host"
                    initialCwd={terminalInitialCwd}
                  />
                )}
              </div>

              {/* Editor Tab Content */}
              {terminalActiveTab === 'editor' && (
                <div className="flex-1 flex flex-col min-h-0">
                  {editorFilePath ? (
                    <>
                      {/* Editor Header */}
                      <div className="flex items-center justify-between p-2 border-b bg-muted/50 shrink-0">
                        <div className="flex items-center gap-2 flex-1 min-w-0">
                          <Code className="h-4 w-4 shrink-0" />
                          <span className="font-mono text-sm truncate" title={editorFilePath}>{editorFilePath}</span>
                          {editorContent !== editorOriginalContent && (
                            <span className="text-yellow-500 text-xs">(unsaved)</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Button
                            variant={editorShowVersions ? "default" : "ghost"}
                            size="sm"
                            onClick={() => {
                              setEditorShowVersions(!editorShowVersions);
                              if (!editorShowVersions) fetchEditorVersions();
                            }}
                            title="Version history"
                          >
                            <History className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setEditorFilePath('');
                              setEditorContent('');
                              setEditorOriginalContent('');
                              setTerminalActiveTab('terminal');
                            }}
                            title="Close editor"
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      {/* Editor + Version History Sidebar */}
                      <div className="flex-1 flex min-h-0 overflow-hidden">
                        {/* Code Editor */}
                        <div className="flex-1 min-h-0 overflow-hidden">
                          <CodeMirror
                            value={editorContent}
                            onChange={setEditorContent}
                            height="100%"
                            theme={oneDark}
                            extensions={[
                              getLanguageFromFile(editorFilePath || 'txt') === 'javascript' ? javascript() :
                              getLanguageFromFile(editorFilePath || 'txt') === 'html' ? html() :
                              getLanguageFromFile(editorFilePath || 'txt') === 'css' ? css() :
                              getLanguageFromFile(editorFilePath || 'txt') === 'json' ? json() :
                              getLanguageFromFile(editorFilePath || 'txt') === 'yaml' ? yaml() :
                              getLanguageFromFile(editorFilePath || 'txt') === 'python' ? python() :
                              getLanguageFromFile(editorFilePath || 'txt') === 'markdown' ? markdown() :
                              getLanguageFromFile(editorFilePath || 'txt') === 'xml' ? xml() : []
                            ].filter(Boolean)}
                            className="h-full overflow-auto text-sm"
                            basicSetup={{
                              lineNumbers: true,
                              foldGutter: true,
                              highlightActiveLineGutter: true,
                              highlightActiveLine: true,
                            }}
                          />
                        </div>

                        {/* Version History Right Sidebar */}
                        {editorShowVersions && (
                          <div className="w-64 border-l bg-muted/30 flex flex-col shrink-0">
                            <div className="p-2 border-b bg-muted/50 flex items-center justify-between shrink-0">
                              <span className="text-sm font-medium flex items-center gap-2">
                                <History className="h-4 w-4" />
                                Git History
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0"
                                onClick={fetchEditorVersions}
                              >
                                <RefreshCw className={`h-3 w-3 ${editorLoadingVersions ? 'animate-spin' : ''}`} />
                              </Button>
                            </div>
                            <div className="flex-1 overflow-auto p-2">
                              {editorLoadingVersions ? (
                                <div className="flex items-center justify-center py-8">
                                  <Loader2 className="h-5 w-5 animate-spin" />
                                </div>
                              ) : editorVersions.length === 0 ? (
                                <p className="text-xs text-muted-foreground text-center py-4">
                                  No git history found for this file
                                </p>
                              ) : (
                                <div className="space-y-1">
                                  {editorVersions.map((v, index) => (
                                    <div
                                      key={v.hash}
                                      className="p-2 rounded border bg-card hover:bg-accent cursor-pointer transition-colors"
                                      onClick={() => revertEditorToVersion(v.hash)}
                                    >
                                      <div className="flex items-center gap-2 mb-1">
                                        <code className="text-xs text-blue-400 font-mono">{v.hash.substring(0, 7)}</code>
                                        {index === 0 && (
                                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-500">latest</span>
                                        )}
                                      </div>
                                      <p className="text-xs text-muted-foreground line-clamp-2">{v.message}</p>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Editor Footer */}
                      <div className="flex items-center justify-between p-2 border-t bg-muted/50 shrink-0">
                        <div className="text-xs text-muted-foreground">
                          <kbd className="px-1.5 py-0.5 bg-muted rounded">Ctrl+S</kbd> Save
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setEditorContent(editorOriginalContent);
                            }}
                            disabled={editorContent === editorOriginalContent}
                          >
                            <RotateCcw className="h-4 w-4 mr-1" />
                            Revert
                          </Button>
                          <Button
                            size="sm"
                            onClick={handleEditorSave}
                            disabled={editorSaving || editorContent === editorOriginalContent}
                          >
                            {editorSaving ? (
                              <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Saving...</>
                            ) : (
                              <><Save className="h-4 w-4 mr-1" />Save</>
                            )}
                          </Button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="flex-1 flex items-center justify-center text-muted-foreground">
                      <div className="text-center">
                        <Code className="h-12 w-12 mx-auto mb-2 opacity-50" />
                        <p>No file open</p>
                        <p className="text-sm mt-1">Double-click a file in the file browser or use <code className="bg-muted px-1 rounded">nano</code>/<code className="bg-muted px-1 rounded">vim</code> command</p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Mobile-only bottom tab bar — switches between Files, Terminal,
              and Editor so each takes the full dialog real estate.
              Hidden on md+ where the side-by-side layout is used. */}
          <div className="md:hidden flex border-t bg-muted shrink-0">
            <button
              type="button"
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-3 text-sm font-medium border-t-2 transition-colors ${
                terminalActiveTab === 'files'
                  ? 'border-primary text-primary bg-background'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setTerminalActiveTab('files')}
              aria-pressed={terminalActiveTab === 'files'}
            >
              <FolderTree className="h-4 w-4" />
              Files
            </button>
            <button
              type="button"
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-3 text-sm font-medium border-t-2 transition-colors ${
                terminalActiveTab === 'terminal'
                  ? 'border-primary text-primary bg-background'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setTerminalActiveTab('terminal')}
              aria-pressed={terminalActiveTab === 'terminal'}
            >
              <Terminal className="h-4 w-4" />
              Terminal
            </button>
            <button
              type="button"
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-3 text-sm font-medium border-t-2 transition-colors ${
                terminalActiveTab === 'editor'
                  ? 'border-primary text-primary bg-background'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setTerminalActiveTab('editor')}
              aria-pressed={terminalActiveTab === 'editor'}
            >
              <Code className="h-4 w-4" />
              Editor
              {editorFilePath && editorContent !== editorOriginalContent && (
                <span className="text-yellow-500">●</span>
              )}
            </button>
          </div>

          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => { setTerminalOutput([]); setTerminalCwd('/'); }}>
              Clear & Reset
            </Button>
            <Button variant="outline" onClick={() => setTerminalOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Zip site-bundle upload — two-phase confirm flow, conflicts
          are listed and only replaced after explicit confirmation */}
      <ZipUploadDialog
        mode="service"
        open={zipUploadOpen}
        onOpenChange={setZipUploadOpen}
        subjectName={selectedService?.name}
        upload={(file, _targetDir, onProgress) => api.uploadServiceZip(selectedService.id, file, onProgress)}
        apply={(uploadId, options) => api.applyServiceZip(selectedService.id, uploadId, options)}
        cancel={(uploadId) => api.cancelServiceZip(selectedService.id, uploadId)}
        onApplied={async () => {
          try {
            const { files: updatedFiles } = await api.getFiles(selectedService.id);
            setFiles(updatedFiles);
          } catch (e) { /* ignore */ }
        }}
      />

      {/* Full Screen File Editor */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className={`max-w-full h-full rounded-none ${isFullscreen ? 'sm:max-w-full sm:h-full sm:m-0 sm:rounded-none' : 'sm:max-w-6xl sm:h-[90vh] sm:rounded-lg'} flex flex-col`}>
          <DialogHeader className="shrink-0">
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle>File Editor - {selectedService?.name}</DialogTitle>
                <DialogDescription>View, create, and edit files for your service</DialogDescription>
              </div>
              <div className="flex gap-2">
                <label>
                  <input type="file" multiple className="hidden" onChange={uploadFilesToService} />
                  <Button variant="outline" size="sm" asChild title="Upload Files to Service">
                    <span><FilePlus className="h-4 w-4" /></span>
                  </Button>
                </label>
                <Button variant="outline" size="sm" onClick={() => setZipUploadOpen(true)} title="Upload ZIP Bundle (extracts into the site)">
                  <FileArchive className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={exportFiles} title="Export Files as JSON">
                  <Download className="h-4 w-4" />
                </Button>
                <label>
                  <input type="file" accept=".json" onChange={importFiles} className="hidden" />
                  <Button variant="outline" size="sm" asChild title="Import Files from JSON">
                    <span><Upload className="h-4 w-4" /></span>
                  </Button>
                </label>
                <Button variant="outline" size="sm" onClick={() => setIsFullscreen(!isFullscreen)}>
                  {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </DialogHeader>

          {/* Path Picker for Static Sites */}
          {selectedService?.type === 'static' && (
            <div className="p-3 bg-muted/50 rounded-lg border mb-2 shrink-0">
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="editorPath" className="text-sm font-medium whitespace-nowrap">Site Path:</Label>
                <Input
                  id="editorPath"
                  defaultValue={selectedService?.dataDir || selectedService?.rootDir || ''}
                  key={selectedService?.id}
                  placeholder="/var/www/mysite"
                  className="flex-1 min-w-[150px] h-8 text-sm font-mono"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.target.blur();
                    }
                  }}
                  onBlur={async (e) => {
                    const newPath = e.target.value.trim();
                    const currentPath = selectedService?.dataDir || selectedService?.rootDir || '';
                    if (newPath && newPath !== currentPath) {
                      try {
                        await api.updateService(selectedService.id, { rootDir: newPath, dataDir: newPath });
                        setSelectedService({ ...selectedService, rootDir: newPath, dataDir: newPath });
                        // Refresh file list
                        const { files: newFiles } = await api.getFiles(selectedService.id);
                        setFiles(newFiles);
                        fetchServices(); // Refresh services list too
                        toast({ title: 'Success', description: 'Path updated successfully' });
                      } catch (error) {
                        toast({ variant: 'destructive', title: 'Error', description: error.message });
                        e.target.value = currentPath; // Revert on error
                      }
                    }
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openTerminal(selectedService?.dataDir || selectedService?.rootDir)}
                  title="Open Terminal in this directory"
                >
                  <Terminal className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Press Enter or click outside to save. This path is used by the file editor, terminal, and Caddy.
              </p>
            </div>
          )}

          <div className="relative flex gap-4 flex-1 min-h-0">
            {/* Mobile file tree backdrop */}
            {mobileFileTreeOpen && (
              <div
                className="fixed inset-0 z-40 bg-black/50 md:hidden"
                onClick={() => setMobileFileTreeOpen(false)}
                aria-hidden="true"
              />
            )}
            {/* File Tree (drawer on <md, static sidebar on md+) */}
            <div
              className={cn(
                "border rounded flex flex-col bg-card",
                "md:w-64 md:shrink-0 md:static md:translate-x-0",
                "fixed inset-y-0 left-0 z-50 w-64 transform transition-transform duration-200 ease-out md:transform-none",
                mobileFileTreeOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
              )}
            >
              <div className="p-2 border-b bg-muted flex items-center justify-between shrink-0">
                <span className="font-medium text-sm">Files</span>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowNewFileInput(true)}>
                    <FilePlus className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 md:hidden"
                    onClick={() => setMobileFileTreeOpen(false)}
                    aria-label="Close file tree"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              {showNewFileInput && (
                <div className="p-2 border-b flex gap-2 shrink-0">
                  <Input placeholder="filename.txt" value={newFileName} onChange={(e) => setNewFileName(e.target.value)} className="h-8 text-sm" />
                  <Button size="sm" onClick={createNewFile} disabled={savingFile}><Check className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" onClick={() => { setShowNewFileInput(false); setNewFileName(''); }}><X className="h-4 w-4" /></Button>
                </div>
              )}
              <div className="flex-1 overflow-auto p-2">
                {files.length > 0 ? renderFileTree(files) : <p className="text-sm text-muted-foreground text-center py-4">No files yet</p>}
              </div>
            </div>

            {/* Editor Area */}
            <div className="flex-1 flex flex-col border rounded min-w-0">
              <div className="p-2 border-b bg-muted flex items-center gap-2 flex-wrap shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  className="md:hidden"
                  onClick={() => setMobileFileTreeOpen(true)}
                  aria-label="Show file tree"
                >
                  <FileText className="h-4 w-4 mr-1" />
                  Files
                </Button>
                <span className="font-medium text-sm truncate flex-1 min-w-0">
                  {selectedFile ? selectedFile.path : 'Select a file to edit'}
                </span>
                {selectedFile && (
                  <>
                    <div className="flex items-center gap-1 px-2 py-1 rounded text-xs" style={{ backgroundColor: getLanguageColor(selectedLanguage) + '20', color: getLanguageColor(selectedLanguage) }}>
                      <Code className="h-3 w-3" />
                      {selectedLanguage}
                    </div>
                    <Select value={selectedLanguage} onValueChange={setSelectedLanguage}>
                      <SelectTrigger className="w-[120px] h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="plaintext">Plain Text</SelectItem>
                        <SelectItem value="html">HTML</SelectItem>
                        <SelectItem value="css">CSS</SelectItem>
                        <SelectItem value="javascript">JavaScript</SelectItem>
                        <SelectItem value="typescript">TypeScript</SelectItem>
                        <SelectItem value="json">JSON</SelectItem>
                        <SelectItem value="yaml">YAML</SelectItem>
                        <SelectItem value="python">Python</SelectItem>
                        <SelectItem value="bash">Bash</SelectItem>
                        <SelectItem value="dockerfile">Dockerfile</SelectItem>
                        <SelectItem value="nginx">Caddyfile</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="outline" size="sm" onClick={loadVersions} disabled={loadingVersions}>
                      <History className="h-4 w-4 mr-1" />
                      History
                    </Button>
                    {hasUnsavedChanges && (
                      <Input
                        className="w-full sm:w-40 h-7 text-xs"
                        placeholder="Version notes..."
                        value={saveNotes}
                        onChange={(e) => setSaveNotes(e.target.value)}
                      />
                    )}
                    <Button size="sm" onClick={saveFile} disabled={savingFile || !hasUnsavedChanges}>
                      {savingFile ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Save className="h-4 w-4 mr-1" />Save</>}
                    </Button>
                  </>
                )}
              </div>

              <div className="flex-1 flex min-h-0">
                {/* Code Editor */}
                <div className={`flex-1 relative overflow-hidden ${hasUnsavedChanges ? 'border-l-2 border-yellow-500' : ''}`}>
                  {selectedFile ? (
                    <CodeMirror
                      value={fileContent}
                      height="100%"
                      theme={oneDark}
                      extensions={[getLanguageExtension(selectedLanguage)].flat()}
                      onChange={(value) => setFileContent(value)}
                      className="h-full text-sm"
                      basicSetup={{
                        lineNumbers: true,
                        highlightActiveLineGutter: true,
                        highlightSpecialChars: true,
                        foldGutter: true,
                        drawSelection: true,
                        dropCursor: true,
                        allowMultipleSelections: true,
                        indentOnInput: true,
                        bracketMatching: true,
                        closeBrackets: true,
                        autocompletion: true,
                        rectangularSelection: true,
                        crosshairCursor: true,
                        highlightActiveLine: true,
                        highlightSelectionMatches: true,
                        closeBracketsKeymap: true,
                        searchKeymap: true,
                        foldKeymap: true,
                        completionKeymap: true,
                        lintKeymap: true,
                      }}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-muted-foreground">
                      Select a file from the tree to view and edit its contents
                    </div>
                  )}
                </div>

                {/* Version History Panel */}
                {showVersions && (
                  <div className="w-64 border-l flex flex-col shrink-0">
                    <div className="p-2 border-b bg-muted flex items-center justify-between shrink-0">
                      <span className="font-medium text-sm">Version History</span>
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowVersions(false)}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex-1 overflow-auto p-2">
                      {versions.length > 0 ? (
                        <div className="space-y-2">
                          {versions.map((v) => (
                            <div key={v.id} className="p-2 border rounded text-sm hover:bg-muted">
                              <div className="flex items-center justify-between">
                                <span className="font-medium">v{v.version}</span>
                                <div className="flex gap-1">
                                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => viewVersion(v)} title="View">
                                    <FileText className="h-3 w-3" />
                                  </Button>
                                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => revertToVersion(v)} title="Revert">
                                    <RotateCcw className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {new Date(v.createdAt).toLocaleString()}
                              </p>
                              {/* Notes section */}
                              {editingNotes === v.id ? (
                                <div className="mt-2 space-y-1">
                                  <textarea
                                    className="w-full p-1 text-xs border rounded bg-background resize-none"
                                    placeholder="Add notes..."
                                    value={noteText}
                                    onChange={(e) => setNoteText(e.target.value)}
                                    rows={2}
                                  />
                                  <div className="flex gap-1">
                                    <Button size="sm" className="h-6 text-xs px-2" onClick={() => updateVersionNotes(v)}>
                                      <Check className="h-3 w-3 mr-1" />Save
                                    </Button>
                                    <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={() => { setEditingNotes(null); setNoteText(''); }}>
                                      Cancel
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <div className="mt-1 flex items-start gap-1">
                                  {v.notes ? (
                                    <p className="text-xs text-muted-foreground italic flex-1 line-clamp-2" title={v.notes}>
                                      <MessageSquare className="h-3 w-3 inline mr-1" />
                                      {v.notes}
                                    </p>
                                  ) : null}
                                  <Button variant="ghost" size="icon" className="h-5 w-5 shrink-0" onClick={() => startEditingNotes(v)} title="Edit notes">
                                    <Edit3 className="h-3 w-3" />
                                  </Button>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground text-center py-4">No versions yet</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Service Settings Dialog */}
      <Dialog open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen}>
        <DialogContent className={settingsTab === 'caddy' ? 'max-w-full h-full rounded-none sm:max-w-5xl sm:h-[90vh] sm:rounded-lg flex flex-col' : 'max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:max-h-[90vh] sm:rounded-lg overflow-y-auto'}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              Service Settings - {settingsService?.name}
            </DialogTitle>
            <DialogDescription>
              Configure Caddy reverse proxy settings for this service
            </DialogDescription>
          </DialogHeader>

          {/* Tabs */}
          <div className="flex gap-2 border-b pb-2">
            <Button
              variant={settingsTab === 'settings' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setSettingsTab('settings')}
            >
              <Settings className="h-4 w-4 mr-2" />
              Settings
            </Button>
            <Button
              variant={settingsTab === 'caddy' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => {
                setSettingsTab('caddy');
                fetchCaddyConfig();
              }}
            >
              <Code className="h-4 w-4 mr-2" />
              Advanced
            </Button>
            <Button
              variant={settingsTab === 'history' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => {
                setSettingsTab('history');
                fetchConfigVersions();
              }}
            >
              <History className="h-4 w-4 mr-2" />
              History
            </Button>
          </div>

          {settingsTab === 'settings' ? (
          <>
          <div className="space-y-4 py-4">
            {/* Service Info */}
            <div className="p-3 bg-muted rounded-lg space-y-1">
              <p className="text-sm"><span className="text-muted-foreground">Domain:</span> {settingsService?.domain}</p>
              <p className="text-sm"><span className="text-muted-foreground">Type:</span> <span className="capitalize">{settingsService?.type}</span></p>
              {/*
               * Phase 2b I.2: Refresh IP button + container summary row
               * for LXC container_services. Only renders when the
               * service was created with runtime='lxc' and a cached
               * container name. The button calls api.refreshLxcIp which
               * re-queries Incus and rewrites every affected domain's
               * merged Caddy config; on success a toast shows the
               * old→new IP and the displayed targetIp is updated from
               * the re-fetched service payload.
               */}
              {settingsService?.kind === 'container_service'
                && settingsService?.runtime === 'lxc'
                && settingsService?.lxcContainerName && (
                <div
                  data-testid="settings-lxc-refresh-ip"
                  className="pt-2 mt-2 border-t border-border/50 space-y-2"
                >
                  <p className="text-sm">
                    <span className="text-muted-foreground">Container:</span>{' '}
                    <code className="font-mono">{settingsService.lxcContainerName}</code>
                  </p>
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <p className="text-sm">
                      <span className="text-muted-foreground">Target IP:</span>{' '}
                      <code className="font-mono" data-testid="settings-lxc-target-ip">{settingsService.targetIp || settingsService.target || '(unknown)'}</code>
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="settings-lxc-refresh-ip-button"
                      className="h-11 sm:h-10 gap-2"
                      onClick={handleRefreshLxcIp}
                      disabled={refreshingLxcIp}
                    >
                      {refreshingLxcIp ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCcw className="h-4 w-4" />
                      )}
                      Refresh IP
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Tip: assign a static IP via an Incus profile to avoid needing this after each container restart.
                  </p>
                </div>
              )}
            </div>

            {/*
             * Phase 2b I.1: HTTP Routes card. Lists every route
             * owned by settingsService, with inline edit + delete per
             * row and an "Add route" inline form keyed on the
             * editingRouteId === 'new' sentinel. Mobile layout stacks
             * each row via flex flex-col + inlines at sm+.
             */}
            <div
              className="space-y-3 border rounded-lg p-3"
              data-testid="settings-routes-card"
            >
              <div className="flex items-center justify-between">
                <h4 className="font-medium text-sm">HTTP Routes</h4>
                <span className="text-xs text-muted-foreground">
                  {settingsRoutesLoading
                    ? 'Loading…'
                    : `${settingsRoutes.length} route${settingsRoutes.length === 1 ? '' : 's'}`}
                </span>
              </div>

              {settingsRoutes.map((route) => (
                <div
                  key={route.id}
                  data-testid={`settings-route-row-${route.id}`}
                  className="rounded-md border"
                >
                  {editingRouteId === route.id ? (
                    // ---- Inline edit form ----
                    <div className="p-3 bg-muted/30 space-y-3">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label htmlFor={`sr-domain-${route.id}`} className="text-xs">Domain</Label>
                          <Input
                            id={`sr-domain-${route.id}`}
                            data-testid={`settings-route-domain-${route.id}`}
                            value={editingRouteDraft.domain}
                            onChange={(e) =>
                              setEditingRouteDraft({ ...editingRouteDraft, domain: e.target.value })
                            }
                            placeholder="app.example.com"
                            required
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`sr-prefix-${route.id}`} className="text-xs">Path prefix</Label>
                          <Input
                            id={`sr-prefix-${route.id}`}
                            data-testid={`settings-route-prefix-${route.id}`}
                            value={editingRouteDraft.pathPrefix}
                            onChange={(e) =>
                              setEditingRouteDraft({ ...editingRouteDraft, pathPrefix: e.target.value })
                            }
                            placeholder="/"
                          />
                        </div>
                      </div>
                      {settingsService?.kind === 'container_service' && (
                        <div className="space-y-1">
                          <Label htmlFor={`sr-port-${route.id}`} className="text-xs">Target port</Label>
                          <Input
                            id={`sr-port-${route.id}`}
                            data-testid={`settings-route-port-${route.id}`}
                            type="number"
                            value={editingRouteDraft.targetPort}
                            onChange={(e) =>
                              setEditingRouteDraft({ ...editingRouteDraft, targetPort: e.target.value })
                            }
                            placeholder="3000"
                            min="1"
                            max="65535"
                          />
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <Label className="text-xs">SSL enabled</Label>
                        <Switch
                          checked={!!editingRouteDraft.sslEnabled}
                          onCheckedChange={(checked) =>
                            setEditingRouteDraft({ ...editingRouteDraft, sslEnabled: checked })
                          }
                        />
                      </div>
                      {renderRouteAdvancedKnobs(`sr-edit-${route.id}`)}
                      <div className="flex gap-2 justify-end">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-11 sm:h-9"
                          onClick={cancelEditSettingsRoute}
                          disabled={savingRoute}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          className="h-11 sm:h-9"
                          data-testid={`settings-route-save-${route.id}`}
                          onClick={saveEditSettingsRoute}
                          disabled={savingRoute}
                        >
                          {savingRoute ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    // ---- Display row ----
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3">
                      <div className="min-w-0 flex-1">
                        <code className="font-mono text-sm break-all">
                          {route.domain}
                          {route.pathPrefix}
                        </code>
                        {route.targetPort != null && (
                          <span className="text-sm text-muted-foreground ml-2">
                            → :{route.targetPort}
                          </span>
                        )}
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {route.sslEnabled === false ? 'HTTP only' : 'HTTPS'}
                        </div>
                      </div>
                      <div className="flex gap-1 shrink-0 justify-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-11 w-11 sm:h-10 sm:w-10"
                          data-testid={`settings-route-edit-${route.id}`}
                          onClick={() => beginEditSettingsRoute(route)}
                          title="Edit route"
                        >
                          <Edit3 className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-11 w-11 sm:h-10 sm:w-10 text-red-500 hover:text-red-600"
                          data-testid={`settings-route-delete-${route.id}`}
                          onClick={() => deleteSettingsRoute(route)}
                          title="Delete route"
                          disabled={savingRoute}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {editingRouteId === 'new' ? (
                <div className="rounded-md border p-3 bg-muted/30 space-y-3" data-testid="settings-route-new-form">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label htmlFor="sr-new-domain" className="text-xs">Domain</Label>
                      <Input
                        id="sr-new-domain"
                        data-testid="settings-route-new-domain"
                        value={editingRouteDraft.domain}
                        onChange={(e) =>
                          setEditingRouteDraft({ ...editingRouteDraft, domain: e.target.value })
                        }
                        placeholder="app.example.com"
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="sr-new-prefix" className="text-xs">Path prefix</Label>
                      <Input
                        id="sr-new-prefix"
                        data-testid="settings-route-new-prefix"
                        value={editingRouteDraft.pathPrefix}
                        onChange={(e) =>
                          setEditingRouteDraft({ ...editingRouteDraft, pathPrefix: e.target.value })
                        }
                        placeholder="/"
                      />
                    </div>
                  </div>
                  {settingsService?.kind === 'container_service' && (
                    <div className="space-y-1">
                      <Label htmlFor="sr-new-port" className="text-xs">Target port</Label>
                      <Input
                        id="sr-new-port"
                        data-testid="settings-route-new-port"
                        type="number"
                        value={editingRouteDraft.targetPort}
                        onChange={(e) =>
                          setEditingRouteDraft({ ...editingRouteDraft, targetPort: e.target.value })
                        }
                        placeholder="3000"
                        min="1"
                        max="65535"
                      />
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">SSL enabled</Label>
                    <Switch
                      checked={!!editingRouteDraft.sslEnabled}
                      onCheckedChange={(checked) =>
                        setEditingRouteDraft({ ...editingRouteDraft, sslEnabled: checked })
                      }
                    />
                  </div>
                  {renderRouteAdvancedKnobs('sr-new')}
                  <div className="flex gap-2 justify-end">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-11 sm:h-9"
                      onClick={cancelEditSettingsRoute}
                      disabled={savingRoute}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-11 sm:h-9"
                      data-testid="settings-route-new-save"
                      onClick={saveEditSettingsRoute}
                      disabled={savingRoute}
                    >
                      {savingRoute ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Add route'}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-11 sm:h-10 w-full sm:w-auto"
                  data-testid="settings-route-add-button"
                  onClick={beginAddSettingsRoute}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add route
                </Button>
              )}
            </div>

            {/* File Path Settings (for static sites) */}
            {settingsService?.type === 'static' && (
              <div className="space-y-3">
                <h4 className="font-medium text-sm">Static Site Path</h4>
                <div className="space-y-2">
                  <Label htmlFor="rootDir">Website Root Directory</Label>
                  <Input
                    id="rootDir"
                    value={settingsForm.rootDir}
                    onChange={(e) => {
                      const newPath = e.target.value;
                      setSettingsForm({ ...settingsForm, rootDir: newPath, dataDir: newPath });
                    }}
                    placeholder="/var/www/mysite"
                  />
                  <p className="text-xs text-muted-foreground">
                    The directory containing your website files (used by Caddy, file editor, and terminal)
                  </p>
                </div>
              </div>
            )}

            {/* Proxy Settings (for docker/proxy types) */}
            {(settingsService?.type === 'docker' || settingsService?.type === 'proxy') && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="target">Target IP/Host</Label>
                    <Input
                      id="target"
                      value={settingsForm.target}
                      onChange={(e) => setSettingsForm({ ...settingsForm, target: e.target.value })}
                      placeholder="127.0.0.1"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="port">Port</Label>
                    <Input
                      id="port"
                      type="number"
                      value={settingsForm.port}
                      onChange={(e) => setSettingsForm({ ...settingsForm, port: e.target.value })}
                      placeholder="8080"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Caddy Settings */}
            <div className="space-y-3">
              <h4 className="font-medium text-sm">Caddy Configuration</h4>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="forceHttps">Force HTTPS</Label>
                  <p className="text-xs text-muted-foreground">Redirect HTTP to HTTPS</p>
                </div>
                <Switch
                  id="forceHttps"
                  checked={settingsForm.forceHttps}
                  onCheckedChange={(checked) => setSettingsForm({ ...settingsForm, forceHttps: checked })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="sslEnabled">SSL Enabled</Label>
                  <p className="text-xs text-muted-foreground">Use HTTPS with SSL certificate</p>
                </div>
                <Switch
                  id="sslEnabled"
                  checked={settingsForm.sslEnabled}
                  onCheckedChange={(checked) => setSettingsForm({ ...settingsForm, sslEnabled: checked })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxUpload">Max Upload Size</Label>
                <Select value={settingsForm.maxUploadSize} onValueChange={(v) => setSettingsForm({ ...settingsForm, maxUploadSize: v })}>
                  <SelectTrigger id="maxUpload">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1M">1 MB</SelectItem>
                    <SelectItem value="10M">10 MB</SelectItem>
                    <SelectItem value="50M">50 MB</SelectItem>
                    <SelectItem value="100M">100 MB</SelectItem>
                    <SelectItem value="500M">500 MB</SelectItem>
                    <SelectItem value="1G">1 GB</SelectItem>
                    <SelectItem value="5G">5 GB</SelectItem>
                    <SelectItem value="10G">10 GB</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsDialogOpen(false)}>Cancel</Button>
            <Button onClick={saveSettings} disabled={savingSettings}>
              {savingSettings ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</> : <><Save className="mr-2 h-4 w-4" />Save Settings</>}
            </Button>
          </DialogFooter>
          </>
          ) : settingsTab === 'caddy' ? (
          /* Advanced Caddy Tab */
          <div className="flex flex-col flex-1 min-h-0 py-4 gap-4">
            <div className="flex items-center justify-between shrink-0">
              <div>
                <h4 className="font-medium text-sm">Caddy Configuration</h4>
                <p className="text-xs text-muted-foreground">Edit the raw Caddyfile for this service</p>
              </div>
              {caddyConfig !== caddyConfigOriginal && (
                <span className="text-xs text-yellow-500">Unsaved changes</span>
              )}
            </div>
            {loadingCaddyConfig ? (
              <div className="flex items-center justify-center flex-1">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : (
              <div className="border rounded-lg overflow-hidden flex-1 min-h-0">
                <CodeMirror
                  value={caddyConfig}
                  height="100%"
                  theme={oneDark}
                  onChange={(value) => setCaddyConfig(value)}
                  basicSetup={{
                    lineNumbers: true,
                    highlightActiveLineGutter: true,
                    foldGutter: true,
                  }}
                  className="h-full"
                />
              </div>
            )}
            <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg shrink-0">
              <p className="text-xs text-yellow-500">
                <strong>Warning:</strong> Invalid configurations will be automatically reverted. The config will be tested before reload.
              </p>
            </div>
            <DialogFooter className="shrink-0">
              <Button variant="outline" onClick={() => setSettingsDialogOpen(false)}>Cancel</Button>
              <Button
                onClick={saveCaddyConfig}
                disabled={savingCaddyConfig || caddyConfig === caddyConfigOriginal}
              >
                {savingCaddyConfig ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</>
                ) : (
                  <><Save className="mr-2 h-4 w-4" />Save & Reload</>
                )}
              </Button>
            </DialogFooter>
          </div>
          ) : (
          /* History Tab */
          <div className="space-y-4 py-4">
            <h4 className="font-medium text-sm">Configuration History</h4>
            {loadingConfigVersions ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : configVersions.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <History className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>No configuration history</p>
                <p className="text-sm mt-1">Changes will be recorded when you save settings</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {configVersions.map((version) => (
                  <div key={version.id} className="p-3 border rounded-lg">
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-medium">Version {version.version}</span>
                        <p className="text-xs text-muted-foreground">
                          {version.notes} • by {version.createdBy}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(version.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRevertConfig(version.id, version.version)}
                        disabled={revertingVersion === version.id}
                      >
                        {revertingVersion === version.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <>
                            <RotateCcw className="h-4 w-4 mr-1" />
                            Revert
                          </>
                        )}
                      </Button>
                    </div>
                    <div className="mt-2 text-xs bg-muted p-2 rounded">
                      <p>Target: {version.config.target || 'N/A'}:{version.config.port || 'N/A'}</p>
                      <p>WebSocket: {version.config.websocketEnabled ? 'Yes' : 'No'} | SSL: {version.config.sslEnabled ? 'Yes' : 'No'}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {settingsService && (
              <ServiceCertMounts
                service={settingsService}
                api={api}
                toast={toast}
              />
            )}
            {settingsService?.lxcContainerName && (
              <ServiceL4AndPorts
                service={settingsService}
                api={api}
                toast={toast}
                onCoverHttp={(seed) => {
                  // Pre-fill the route-add form with the chip's port so
                  // the operator just types the domain. Defaults match
                  // the new-route helper above.
                  setEditingRouteId('new');
                  setEditingRouteDraft({
                    domain: '',
                    pathPrefix: '/',
                    targetPort: String(seed.port),
                    sslEnabled: true,
                    forceHttps: true,
                    websocketEnabled: false,
                    maxUploadSize: '1G',
                    stripPrefix: false,
                    readTimeoutSeconds: '',
                    writeTimeoutSeconds: '',
                    hostHeaderOverride: '',
                    allowFraming: false,
                    frameAncestors: '',
                  });
                }}
              />
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setSettingsDialogOpen(false)}>Close</Button>
            </DialogFooter>
          </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Export Dialog */}
      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Export Services</DialogTitle>
            <DialogDescription>Select services to export and download as JSON</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Select Services</Label>
              <div className="border rounded p-2 max-h-48 overflow-auto">
                {services.filter(s => !s.isAdmin).map((service) => (
                  <div key={service.id} className="flex items-center gap-2 p-2 hover:bg-muted rounded cursor-pointer" onClick={() => toggleExportService(service.id)}>
                    <div className={`w-4 h-4 border rounded flex items-center justify-center ${exportServiceIds.includes(service.id) ? 'bg-primary border-primary' : ''}`}>
                      {exportServiceIds.includes(service.id) && <Check className="h-3 w-3 text-primary-foreground" />}
                    </div>
                    <span>{service.name}</span>
                  </div>
                ))}
                {services.filter(s => !s.isAdmin).length === 0 && <p className="text-sm text-muted-foreground text-center py-2">No services to export</p>}
              </div>
              <p className="text-xs text-muted-foreground">Leave empty to export all services</p>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="includeFiles">Include Files</Label>
              <Switch id="includeFiles" checked={exportIncludeFiles} onCheckedChange={setExportIncludeFiles} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExportDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleExport} disabled={submitting}>
              {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Exporting...</> : <><Download className="mr-2 h-4 w-4" />Export</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Dialog */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle>Import Services</DialogTitle>
            <DialogDescription>Upload a previously exported JSON file to import services</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Upload File</Label>
              <Input type="file" accept=".json" onChange={handleFileUpload} />
            </div>
            <div className="space-y-2">
              <Label>Or Paste JSON</Label>
              <textarea className="w-full h-32 p-2 border rounded font-mono text-sm" value={importData} onChange={(e) => setImportData(e.target.value)} placeholder='{"services": [...]}' />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="overwrite">Overwrite Existing</Label>
              <Switch id="overwrite" checked={importOverwrite} onCheckedChange={setImportOverwrite} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleImport} disabled={!importData || submitting}>
              {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Importing...</> : <><Upload className="mr-2 h-4 w-4" />Import</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Kill Switch Dialog */}
      <Dialog open={killSwitchDialogOpen} onOpenChange={setKillSwitchDialogOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-500">
              <ShieldAlert className="h-5 w-5" />
              Secure System - Kill Switch
            </DialogTitle>
            <DialogDescription>
              This will stop the ProxyPilot admin container. All your services, Caddy configurations,
              and Docker containers will continue running. The admin dashboard will become unavailable
              until the container is manually restarted.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
              <p className="text-sm text-red-500 font-medium">Warning:</p>
              <ul className="text-sm text-muted-foreground mt-2 space-y-1 list-disc list-inside">
                <li>Admin dashboard will be inaccessible</li>
                <li>A secure landing page will be shown to visitors</li>
                <li>To restore, run: <code className="bg-muted px-1 rounded">docker start proxypilot-admin</code></li>
              </ul>
            </div>
            <PasskeyConfirmButton
              hasPasskey={typeof window !== 'undefined' && localStorage.getItem('pp_has_passkey') === 'true'}
              onAssertion={(assertion) => handleSecureSystem(assertion)}
              disabled={securingSystem}
              className="w-full"
            />
            <div className="space-y-2">
              <Label htmlFor="killSwitchTotp">TOTP Code</Label>
              <Input
                id="killSwitchTotp"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter 6-digit code"
                maxLength={6}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setKillSwitchDialogOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => handleSecureSystem()}
              disabled={totpCode.length !== 6 || securingSystem}
            >
              {securingSystem ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Securing...</>
              ) : (
                <><ShieldAlert className="mr-2 h-4 w-4" />Secure System</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Discover Dialog */}
      <Dialog open={discoverDialogOpen} onOpenChange={setDiscoverDialogOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-2xl sm:h-auto sm:max-h-[80vh] sm:rounded-lg overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Radar className="h-5 w-5" />
              Discover Existing Sites
            </DialogTitle>
            <DialogDescription>
              Discover and import existing Caddy sites and Docker Compose services from this server.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4 py-4">
            {discoveringCaddy ? (
              <div className="flex items-center justify-center p-8">
                <Loader2 className="h-8 w-8 animate-spin" />
                <span className="ml-2">Scanning for sites...</span>
              </div>
            ) : discoveredSites.length === 0 ? (
              <div className="text-center p-8 text-muted-foreground">
                <Radar className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No new sites discovered</p>
                <p className="text-sm">All existing Caddy sites are already imported.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">Found {discoveredSites.length} site(s) that can be imported:</p>
                {discoveredSites.map((site) => (
                  <Card key={site.domain} className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          {site.type === 'static' ? (
                            <FolderOpen className="h-4 w-4 text-blue-500" />
                          ) : (
                            <Container className="h-4 w-4 text-purple-500" />
                          )}
                          <span className="font-medium">{site.name}</span>
                          <span className="text-xs px-2 py-0.5 rounded bg-muted">{site.type}</span>
                          {site.sslEnabled && <ShieldCheck className="h-4 w-4 text-green-500" title="SSL Enabled" />}
                          {site.websocketEnabled && <Activity className="h-4 w-4 text-blue-500" title="WebSocket Enabled" />}
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">{site.domain}</p>
                        {site.rootDir && <p className="text-xs text-muted-foreground">Root: {site.rootDir}</p>}
                        {site.target && site.port && <p className="text-xs text-muted-foreground">Target: {site.target}:{site.port}</p>}
                        {!site.target && site.port && <p className="text-xs text-muted-foreground">Port: {site.port}</p>}
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => importSite(site)}
                          disabled={importingSite === site.domain}
                        >
                          {importingSite === site.domain ? (
                            <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Importing</>
                          ) : (
                            <><Import className="h-4 w-4 mr-1" />Import</>
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => openRemoveDialog(site)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {/* Docker Compose Services Section */}
            {composeServices.length > 0 && (
              <div className="mt-6 border-t pt-4">
                <h3 className="font-medium flex items-center gap-2 mb-3">
                  <Boxes className="h-4 w-4" />
                  Docker Compose Services
                </h3>
                <div className="space-y-2">
                  {composeServices.map((svc) => (
                    <Card key={svc.id} className="p-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${svc.isRunning ? 'bg-green-500' : 'bg-gray-400'}`} />
                          <span className="font-medium">{svc.containerName}</span>
                          <span className="text-xs px-2 py-0.5 rounded bg-muted">{svc.projectName}</span>
                        </div>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <span>{svc.image?.split(':')[0]}</span>
                          {svc.exposedPort && <span className="text-xs">:{svc.exposedPort}</span>}
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button variant="outline" onClick={() => discoverSites()}>
              <RefreshCcw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            <Button variant="outline" onClick={() => setDiscoverDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Site Dialog */}
      <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-500">
              <Trash2 className="h-5 w-5" />
              Remove Site
            </DialogTitle>
            <DialogDescription>
              Remove <strong>{siteToRemove?.name}</strong> ({siteToRemove?.domain}) and its associated resources.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-3">
              <Label className="text-sm font-medium">What to remove:</Label>

              <div className="flex items-center justify-between p-3 border rounded-lg">
                <div className="flex items-center gap-2">
                  <FolderOpen className="h-4 w-4 text-blue-500" />
                  <div>
                    <p className="font-medium text-sm">Caddy Config & Files</p>
                    <p className="text-xs text-muted-foreground">Site config and root directory</p>
                  </div>
                </div>
                <Switch
                  checked={removeOptions.files}
                  onCheckedChange={(checked) => setRemoveOptions({ ...removeOptions, files: checked })}
                />
              </div>

              {siteToRemove?.type === 'docker' && (
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center gap-2">
                    <Container className="h-4 w-4 text-purple-500" />
                    <div>
                      <p className="font-medium text-sm">Docker Resources</p>
                      <p className="text-xs text-muted-foreground">Containers, images & volumes</p>
                    </div>
                  </div>
                  <Switch
                    checked={removeOptions.docker}
                    onCheckedChange={(checked) => setRemoveOptions({ ...removeOptions, docker: checked })}
                  />
                </div>
              )}

              {siteToRemove?.sslEnabled && (
                <div className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-green-500" />
                    <div>
                      <p className="font-medium text-sm">SSL Certificate</p>
                      <p className="text-xs text-muted-foreground">Caddy auto-managed certificate</p>
                    </div>
                  </div>
                  <Switch
                    checked={removeOptions.cert}
                    onCheckedChange={(checked) => setRemoveOptions({ ...removeOptions, cert: checked })}
                  />
                </div>
              )}
            </div>

            <div className="space-y-2 pt-2 border-t">
              <Label className="text-sm">Type <strong>{siteToRemove?.domain}</strong> to confirm:</Label>
              <Input
                value={removingConfirmation}
                onChange={(e) => setRemovingConfirmation(e.target.value)}
                placeholder={siteToRemove?.domain}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveDialogOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleRemoveSite}
              disabled={removingSite || removingConfirmation !== siteToRemove?.domain || (!removeOptions.files && !removeOptions.docker && !removeOptions.cert)}
            >
              {removingSite ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Removing...</>
              ) : (
                <><Trash2 className="h-4 w-4 mr-2" />Remove Site</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nano Editor Dialog */}
      <Dialog open={nanoEditorOpen} onOpenChange={setNanoEditorOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-4xl sm:h-[80vh] sm:rounded-lg flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2 font-mono">
              <Code className="h-5 w-5" />
              {nanoFilePath || 'New File'}
            </DialogTitle>
            <DialogDescription>
              ProxyPilot File Editor (nano replacement)
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-hidden">
            <CodeMirror
              value={nanoFileContent}
              onChange={setNanoFileContent}
              height="100%"
              theme={oneDark}
              extensions={[
                getLanguageFromFile(nanoFilePath || 'txt') === 'javascript' ? javascript() :
                getLanguageFromFile(nanoFilePath || 'txt') === 'html' ? html() :
                getLanguageFromFile(nanoFilePath || 'txt') === 'css' ? css() :
                getLanguageFromFile(nanoFilePath || 'txt') === 'json' ? json() :
                getLanguageFromFile(nanoFilePath || 'txt') === 'yaml' ? yaml() :
                getLanguageFromFile(nanoFilePath || 'txt') === 'python' ? python() :
                getLanguageFromFile(nanoFilePath || 'txt') === 'markdown' ? markdown() :
                getLanguageFromFile(nanoFilePath || 'txt') === 'xml' ? xml() : []
              ].filter(Boolean)}
              className="h-full overflow-auto text-sm"
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLineGutter: true,
                highlightActiveLine: true,
              }}
            />
          </div>
          <DialogFooter className="shrink-0">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mr-auto">
              <kbd className="px-2 py-1 bg-muted rounded text-xs">Ctrl+S</kbd> Save
            </div>
            <Button variant="outline" onClick={() => setNanoEditorOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleNanoSave} disabled={nanoSaving}>
              {nanoSaving ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</>
              ) : (
                <><Save className="mr-2 h-4 w-4" />Save</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-Click Install Dialog */}
      <Dialog open={oneClickDialogOpen} onOpenChange={setOneClickDialogOpen}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-lg sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Rocket className="h-5 w-5 text-green-500" />
              One-Click Install
            </DialogTitle>
            <DialogDescription>
              Install pre-configured services with one click. All passwords are auto-generated.
            </DialogDescription>
          </DialogHeader>

          {!oneClickService ? (
            <div className="grid grid-cols-1 gap-4 py-4">
              <Card
                className="cursor-pointer hover:border-green-500 transition-colors"
                onClick={() => setOneClickService('wordpress')}
              >
                <CardHeader className="text-center pb-2">
                  <Package className="h-12 w-12 mx-auto text-blue-500" />
                  <CardTitle className="text-lg">WordPress</CardTitle>
                </CardHeader>
                <CardContent>
                  <CardDescription className="text-center">
                    Full WordPress with MySQL, auto-configured SSL
                  </CardDescription>
                </CardContent>
              </Card>
            </div>
          ) : oneClickService === 'wordpress' ? (
            <div className="space-y-4 py-4">
              <div className="flex items-center gap-2 p-2 bg-muted rounded">
                <Package className="h-5 w-5 text-blue-500" />
                <span className="font-medium">WordPress Installation</span>
              </div>

              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="siteName">Site Name</Label>
                  <Input
                    id="siteName"
                    value={oneClickForm.siteName}
                    onChange={(e) => setOneClickForm({ ...oneClickForm, siteName: e.target.value })}
                    placeholder="My WordPress Site"
                  />
                  <p className="text-xs text-muted-foreground">
                    Used for container naming (e.g., wp_mysite_app)
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="domain">Domain</Label>
                  <Input
                    id="domain"
                    value={oneClickForm.domain}
                    onChange={(e) => setOneClickForm({ ...oneClickForm, domain: e.target.value })}
                    placeholder="blog.example.com"
                  />
                  <p className="text-xs text-muted-foreground">
                    SSL certificate will be obtained automatically
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="wpPort">WordPress Port</Label>
                    <Input
                      id="wpPort"
                      type="number"
                      value={oneClickForm.wordpressPort}
                      onChange={(e) => setOneClickForm({ ...oneClickForm, wordpressPort: e.target.value })}
                      placeholder="7000"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="dbPort">Database Port</Label>
                    <Input
                      id="dbPort"
                      type="number"
                      value={oneClickForm.dbPort}
                      onChange={(e) => setOneClickForm({ ...oneClickForm, dbPort: e.target.value })}
                      placeholder="7001"
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Ports will be automatically adjusted if already in use
                </p>
              </div>

              <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-3 space-y-1 text-sm">
                <p className="font-medium text-green-600">What will be created:</p>
                <ul className="text-xs text-muted-foreground space-y-0.5 list-disc list-inside">
                  <li>Docker Compose stack with WordPress + MySQL</li>
                  <li>.env file with secure auto-generated passwords</li>
                  <li>Caddy reverse proxy configuration</li>
                  <li>SSL certificate via Caddy (automatic ACME)</li>
                </ul>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            {oneClickService && (
              <Button variant="outline" onClick={() => setOneClickService(null)}>
                Back
              </Button>
            )}
            <Button variant="outline" onClick={() => { setOneClickDialogOpen(false); setOneClickService(null); }}>
              Cancel
            </Button>
            {oneClickService && (
              <Button
                onClick={handleOneClickInstall}
                disabled={oneClickInstalling || !oneClickForm.siteName || !oneClickForm.domain}
                className="bg-green-600 hover:bg-green-700"
              >
                {oneClickInstalling ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Installing...</>
                ) : (
                  <><Rocket className="mr-2 h-4 w-4" />Install WordPress</>
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Folder Management Dialog */}
      <Dialog open={folderDialogOpen} onOpenChange={(open) => {
        setFolderDialogOpen(open);
        if (!open) {
          setSelectedServiceForFolder(null);
          setSelectedParentFolder(null);
          setNewFolderName('');
        }
      }}>
        <DialogContent className="max-w-full h-full rounded-none sm:max-w-md sm:h-auto sm:rounded-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderTree className="h-5 w-5 text-yellow-500" />
              {selectedServiceForFolder ? 'Move to Folder' : 'Manage Folders'}
            </DialogTitle>
            <DialogDescription>
              {selectedServiceForFolder
                ? `Move "${selectedServiceForFolder.name}" to a folder`
                : selectedParentFolder
                  ? `Create subfolder in "${serviceFolders[selectedParentFolder]?.name}"`
                  : 'Create folders to organize your services'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Create new folder */}
            <div className="space-y-2">
              <Label>Create New Folder{selectedParentFolder ? ` in "${serviceFolders[selectedParentFolder]?.name}"` : ''}</Label>
              <div className="flex gap-2">
                <Input
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="Folder name"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newFolderName.trim()) {
                      createFolder(newFolderName.trim(), selectedParentFolder);
                      const desc = selectedParentFolder
                        ? `Created subfolder "${newFolderName}" in "${serviceFolders[selectedParentFolder]?.name}"`
                        : `Created folder "${newFolderName}"`;
                      setNewFolderName('');
                      setSelectedParentFolder(null);
                      toast({ title: 'Folder created', description: desc });
                    }
                  }}
                />
                <Button
                  onClick={() => {
                    if (newFolderName.trim()) {
                      createFolder(newFolderName.trim(), selectedParentFolder);
                      const desc = selectedParentFolder
                        ? `Created subfolder "${newFolderName}" in "${serviceFolders[selectedParentFolder]?.name}"`
                        : `Created folder "${newFolderName}"`;
                      setNewFolderName('');
                      setSelectedParentFolder(null);
                      toast({ title: 'Folder created', description: desc });
                    }
                  }}
                  disabled={!newFolderName.trim()}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              {selectedParentFolder && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedParentFolder(null)}
                  className="text-xs"
                >
                  Create in root instead
                </Button>
              )}
            </div>

            {/* List existing folders */}
            {Object.keys(serviceFolders).length > 0 && (
              <div className="space-y-2">
                <Label>{selectedServiceForFolder ? 'Select Folder' : 'Existing Folders'}</Label>
                <div className="space-y-2 max-h-48 overflow-auto">
                  {selectedServiceForFolder && (
                    <div
                      className="flex items-center gap-2 p-2 border rounded cursor-pointer hover:bg-muted"
                      onClick={() => {
                        moveServiceToFolder(selectedServiceForFolder.id, null);
                        setFolderDialogOpen(false);
                        toast({ title: 'Moved', description: `"${selectedServiceForFolder.name}" removed from folder` });
                      }}
                    >
                      <X className="h-4 w-4 text-muted-foreground" />
                      <span className="text-muted-foreground">No folder (root level)</span>
                    </div>
                  )}
                  {Object.entries(serviceFolders).map(([path, folder]) => (
                    <div
                      key={path}
                      className={`flex items-center justify-between p-2 border rounded ${selectedServiceForFolder ? 'cursor-pointer hover:bg-muted' : ''}`}
                      onClick={() => {
                        if (selectedServiceForFolder) {
                          moveServiceToFolder(selectedServiceForFolder.id, path);
                          setFolderDialogOpen(false);
                          toast({ title: 'Moved', description: `"${selectedServiceForFolder.name}" moved to "${folder.name}"` });
                        }
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <Folder className="h-4 w-4 text-yellow-500" />
                        <span>{folder.name}</span>
                        <span className="text-sm text-muted-foreground">
                          ({folder.services?.length || 0} services)
                        </span>
                      </div>
                      {!selectedServiceForFolder && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-red-500"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteFolder(path);
                            toast({ title: 'Deleted', description: `Folder "${folder.name}" deleted` });
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {Object.keys(serviceFolders).length === 0 && !selectedServiceForFolder && (
              <p className="text-sm text-muted-foreground text-center py-4">
                No folders yet. Create your first folder above.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFolderDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
