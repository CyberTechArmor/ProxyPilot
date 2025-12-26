import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
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
import { useToast } from '@/hooks/use-toast';
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
  RefreshCcw,
  Terminal,
  Play,
  Square,
  RotateCw,
  Radar,
  Import,
  Boxes,
  LayoutGrid,
  List,
  Package,
  Rocket,
  FolderTree,
  Eye,
  ArrowUp,
  ArrowDown,
  FolderPlus,
  GripVertical,
  Cpu,
  HardDrive,
  MemoryStick,
  Activity,
  Clock,
} from 'lucide-react';

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
  const [services, setServices] = useState([]);
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

  // Search/Filter/Sort state
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [sortBy, setSortBy] = useState('favorite');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);

  // Full screen editor state
  const [editorOpen, setEditorOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Add service wizard state
  const [wizardStep, setWizardStep] = useState(0);
  const [formData, setFormData] = useState({
    name: '',
    domain: '',
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
  const terminalOutputRef = useCallback(node => {
    if (node) node.scrollTop = node.scrollHeight;
  }, [terminalOutput]);
  const terminalInputRef = useRef(null);

  // Kill switch state
  const [killSwitchDialogOpen, setKillSwitchDialogOpen] = useState(false);
  const [securingSystem, setSecuringSystem] = useState(false);

  // Discovery state
  const [discoverDialogOpen, setDiscoverDialogOpen] = useState(false);
  const [discoveredSites, setDiscoveredSites] = useState([]);
  const [discoveringNginx, setDiscoveringNginx] = useState(false);
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

  // Terminal tab state (terminal vs editor)
  const [terminalActiveTab, setTerminalActiveTab] = useState('terminal'); // 'terminal' or 'editor'
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

  // Dashboard view state - tabs for Resources, Services, Compose
  const [dashboardTab, setDashboardTab] = useState(() => {
    return localStorage.getItem('dashboardDefaultTab') || 'resources';
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
    setDiscoveringNginx(true);
    try {
      const { sites } = await api.discoverNginxSites();
      setDiscoveredSites(sites || []);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to discover sites: ' + error.message,
      });
    } finally {
      setDiscoveringNginx(false);
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

      // Remove NGINX config files
      if (removeOptions.files) {
        commands.push(`rm -f /etc/nginx/sites-available/${siteToRemove.domain}`);
        commands.push(`rm -f /etc/nginx/sites-enabled/${siteToRemove.domain}`);
        if (siteToRemove.rootDir && siteToRemove.type === 'static') {
          commands.push(`rm -rf "${siteToRemove.rootDir}"`);
        }
      }

      // Remove Docker containers, images, and volumes
      if (removeOptions.docker && siteToRemove.composePath) {
        commands.push(`cd "${siteToRemove.composePath}" && docker compose down -v --rmi local 2>/dev/null || true`);
        commands.push(`rm -rf "${siteToRemove.composePath}"`);
      }

      // Remove SSL certificate
      if (removeOptions.cert && siteToRemove.sslEnabled) {
        commands.push(`certbot delete --cert-name ${siteToRemove.domain} --non-interactive 2>/dev/null || true`);
        commands.push(`rm -rf /etc/letsencrypt/live/${siteToRemove.domain}`);
        commands.push(`rm -rf /etc/letsencrypt/archive/${siteToRemove.domain}`);
        commands.push(`rm -f /etc/letsencrypt/renewal/${siteToRemove.domain}.conf`);
      }

      // Execute removal commands
      for (const cmd of commands) {
        await api.executeCommand(cmd, '/');
      }

      // Reload NGINX
      await api.executeCommand('nginx -t && nginx -s reload 2>/dev/null || true', '/');

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

  const handleAddService = async (e) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const submitData = { ...formData };
      if (formData.port) {
        submitData.port = parseInt(formData.port, 10);
      }
      await api.createService(submitData);
      toast({
        title: 'Success',
        description: 'Service created successfully',
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

  const handleDeleteService = async () => {
    if (!serviceToDelete || !totpCode) return;
    setSubmitting(true);

    try {
      await api.deleteService(serviceToDelete.id, totpCode);
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

  const handleReloadNginx = async () => {
    try {
      await api.reloadNginx();
      toast({
        title: 'Success',
        description: 'NGINX reloaded successfully',
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
        title: result.nginxReloaded ? 'Success' : 'Partial Success',
        description: `Regenerated ${result.results.success.length} configs${result.results.failed.length > 0 ? `, ${result.results.failed.length} failed` : ''}. NGINX ${result.nginxReloaded ? 'reloaded' : 'reload failed'}`,
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
          : 'Configuration regenerated. SSL certificate still missing - run certbot to obtain certificate.',
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
      domain: '',
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

  const confirmRemoveCertificate = async () => {
    if (!serviceToRemoveCert || !totpCode) return;

    setSubmitting(true);
    try {
      await api.removeCertificate(serviceToRemoveCert.id, totpCode);
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

  const openTerminal = async (initialDir = null) => {
    // Always start with /root if no directory specified
    const startDir = initialDir || '/root';
    setTerminalCwd(startDir);
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

  const handleDestroyProject = async () => {
    if (!projectToDestroy || destroyTotpCode.length !== 6) return;

    setDestroyingProject(true);
    try {
      const result = await api.dockerComposeDestroy(
        projectToDestroy.composePath,
        destroyTotpCode,
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

        // Pre-fill the proxy container form
        setFormData({
          name: composeCreateForm.serviceName,
          domain: '',
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

  // Reorder folder (move up or down)
  const reorderFolder = (folderPath, direction) => {
    const folder = serviceFolders[folderPath];
    if (!folder) return;

    // Get sibling folders (same parent)
    const siblings = Object.entries(serviceFolders)
      .filter(([, f]) => f.parentPath === folder.parentPath)
      .sort((a, b) => (a[1].order || 0) - (b[1].order || 0));

    const currentIndex = siblings.findIndex(([path]) => path === folderPath);
    if (currentIndex === -1) return;

    const swapIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (swapIndex < 0 || swapIndex >= siblings.length) return;

    // Swap orders
    const [swapPath] = siblings[swapIndex];
    const newFolders = { ...serviceFolders };
    const currentOrder = newFolders[folderPath].order || 0;
    const swapOrder = newFolders[swapPath].order || 0;
    newFolders[folderPath] = { ...newFolders[folderPath], order: swapOrder };
    newFolders[swapPath] = { ...newFolders[swapPath], order: currentOrder };
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
  };

  const handleFolderDragOver = (e, folderPath) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverFolder(folderPath);
  };

  const handleFolderDragLeave = () => {
    setDragOverFolder(null);
  };

  const handleFolderDrop = (e, targetPath) => {
    e.preventDefault();
    setDragOverFolder(null);

    if (draggedService) {
      moveServiceToFolder(draggedService.id, targetPath);
      toast({
        title: 'Service moved',
        description: `"${draggedService.name}" moved to "${serviceFolders[targetPath]?.name || 'root'}"`
      });
      setDraggedService(null);
    } else if (draggedFolder && draggedFolder !== targetPath) {
      if (moveFolderToFolder(draggedFolder, targetPath)) {
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
  const handleSecureSystem = async () => {
    if (!totpCode || totpCode.length !== 6) return;
    setSecuringSystem(true);

    try {
      await api.secureSystem(totpCode);
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
    setSelectedService(service);
    setFiles([]);
    setSelectedFile(null);
    setFileContent('');
    setOriginalContent('');
    setVersions([]);
    setShowVersions(false);
    setEditorOpen(true);
    setExpandedDirs({});

    try {
      const { files } = await api.getFiles(service.id);
      setFiles(files);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Failed to load files',
      });
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
        description: result.nginxReloaded
          ? 'File saved and NGINX reloaded'
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
        return <Server className="h-5 w-5" />;
      case 'static':
        return <FolderOpen className="h-5 w-5" />;
      case 'docker':
        return <Container className="h-5 w-5" />;
      default:
        return <Globe className="h-5 w-5" />;
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Services</h1>
          <p className="text-muted-foreground">
            Manage your proxy services and domains
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleReloadNginx} title="Reload NGINX">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            onClick={handleRegenerateAllConfigs}
            disabled={regeneratingAll}
            title="Regenerate All NGINX Configs"
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
          <Button variant="outline" onClick={() => openTerminal()}>
            <Terminal className="h-4 w-4 mr-2" />
            Terminal
          </Button>
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
            <DialogContent className={wizardStep === 0 ? "max-w-3xl" : "max-w-lg"}>
              <DialogHeader>
                <DialogTitle>Add New Service</DialogTitle>
                <DialogDescription>
                  {wizardStep === 0 ? 'Select the type of service to create' : 'Configure your service details'}
                </DialogDescription>
              </DialogHeader>

              {wizardStep === 0 ? (
                <div className="grid grid-cols-3 gap-4 py-4">
                  <Card className="cursor-pointer hover:border-primary transition-colors" onClick={() => handleTypeSelect('static')}>
                    <CardHeader className="text-center pb-2">
                      <FolderOpen className="h-12 w-12 mx-auto text-primary" />
                      <CardTitle className="text-lg">Static Site</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription className="text-center">Serve static HTML, CSS, and JavaScript files</CardDescription>
                    </CardContent>
                  </Card>
                  <Card className="cursor-pointer hover:border-primary transition-colors" onClick={() => handleTypeSelect('docker')}>
                    <CardHeader className="text-center pb-2">
                      <Container className="h-12 w-12 mx-auto text-primary" />
                      <CardTitle className="text-lg">Proxy Container</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription className="text-center">Proxy to a Docker container running on a port</CardDescription>
                    </CardContent>
                  </Card>
                  <Card className="cursor-pointer hover:border-purple-500 border-purple-500/30 transition-colors" onClick={() => {
                    setAddDialogOpen(false);
                    setComposeCreateOpen(true);
                    setComposeCreateForm({
                      serviceName: '',
                      composeContent: DEFAULT_COMPOSE_CONTENT,
                      envVars: [],
                    });
                  }}>
                    <CardHeader className="text-center pb-2">
                      <Boxes className="h-12 w-12 mx-auto text-purple-500" />
                      <CardTitle className="text-lg">Docker Compose</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription className="text-center">Create a multi-container app with docker-compose.yml</CardDescription>
                    </CardContent>
                  </Card>
                </div>
              ) : (
                <form onSubmit={handleAddService} className="space-y-4">
                  <div className="flex items-center gap-2 p-2 bg-muted rounded mb-4">
                    {formData.type === 'static' ? <FolderOpen className="h-5 w-5 text-primary" /> : <Container className="h-5 w-5 text-primary" />}
                    <span className="font-medium capitalize">{formData.type} Site</span>
                    <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setWizardStep(0)}>Change</Button>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="name">Service Name</Label>
                    <Input id="name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="My Application" required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="domain">Domain</Label>
                    <Input id="domain" value={formData.domain} onChange={(e) => setFormData({ ...formData, domain: e.target.value })} placeholder="app.example.com" required />
                  </div>
                  {formData.type === 'docker' && (
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
                      <div className="space-y-2">
                        <Label htmlFor="port">Port</Label>
                        <Input id="port" type="number" value={formData.port} onChange={(e) => setFormData({ ...formData, port: e.target.value })} placeholder="3000" min="1" max="65535" required />
                      </div>
                      <div className="flex items-center justify-between">
                        <Label htmlFor="websocketEnabled">WebSocket Support</Label>
                        <Switch id="websocketEnabled" checked={formData.websocketEnabled} onCheckedChange={(checked) => setFormData({ ...formData, websocketEnabled: checked })} />
                      </div>
                    </>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="maxUploadSize">Max Upload Size</Label>
                    <Input id="maxUploadSize" value={formData.maxUploadSize} onChange={(e) => setFormData({ ...formData, maxUploadSize: e.target.value })} placeholder="1G" />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label htmlFor="sslEnabled">SSL Enabled</Label>
                    <Switch id="sslEnabled" checked={formData.sslEnabled} onCheckedChange={(checked) => setFormData({ ...formData, sslEnabled: checked })} />
                  </div>
                  {formData.sslEnabled && (
                    <div className="flex items-center justify-between pl-4 border-l-2 border-primary/20">
                      <div>
                        <Label htmlFor="obtainCertificate">Auto-obtain Certificate</Label>
                        <p className="text-xs text-muted-foreground">Get Let's Encrypt certificate automatically</p>
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
                </form>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Dashboard Tabs */}
      <div className="flex items-center gap-2 border-b pb-2">
        <div className="flex gap-1 p-1 bg-muted rounded-lg">
          <Button
            variant={dashboardTab === 'resources' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setDashboardTab('resources')}
            className="gap-2"
          >
            <Activity className="h-4 w-4" />
            Resources
          </Button>
          <Button
            variant={dashboardTab === 'services' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setDashboardTab('services')}
            className="gap-2"
          >
            <LayoutGrid className="h-4 w-4" />
            Services
          </Button>
          <Button
            variant={dashboardTab === 'compose' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setDashboardTab('compose')}
            className="gap-2"
          >
            <Container className="h-4 w-4" />
            Compose
          </Button>
        </div>
        <div className="ml-auto flex items-center gap-2">
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
            <option value="compose">Compose</option>
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
          <SelectTrigger className="w-[140px]">
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
          <SelectTrigger className="w-[140px]">
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
      <div className="flex gap-4">
        {/* Left Sidebar - Folder Navigation */}
        <div className="w-56 shrink-0">
          <div className="border rounded-lg sticky top-4">
            <div className="p-3 border-b bg-muted/50 flex items-center justify-between">
              <span className="font-medium text-sm flex items-center gap-2">
                <FolderTree className="h-4 w-4" />
                Folders
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
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
            <div className="p-2 space-y-1">
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

                      return (
                        <div key={folderPath}>
                          <div
                            draggable
                            onDragStart={(e) => handleFolderDragStart(e, folderPath)}
                            onDragEnd={handleFolderDragEnd}
                            onDragOver={(e) => handleFolderDragOver(e, folderPath)}
                            onDragLeave={handleFolderDragLeave}
                            onDrop={(e) => handleFolderDrop(e, folderPath)}
                            className={`group flex items-center gap-1 px-2 py-1.5 rounded cursor-pointer text-sm transition-colors ${
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
                                reorderFolder(folderPath, 'up');
                              }}
                              title="Move up"
                            >
                              <ArrowUp className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className={`h-5 w-5 p-0 opacity-0 group-hover:opacity-100 ${isSelected ? 'text-primary-foreground hover:text-primary/70' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                reorderFolder(folderPath, 'down');
                              }}
                              title="Move down"
                            >
                              <ArrowDown className="h-3 w-3" />
                            </Button>
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
          <div className={viewMode === 'grid' ? 'grid gap-4 md:grid-cols-2 lg:grid-cols-3' : 'space-y-2'}>
            {filteredServices.map((service) => (
          <Card
            key={service.id}
            draggable
            onDragStart={(e) => handleServiceDragStart(e, service)}
            onDragEnd={handleServiceDragEnd}
            className={`${service.isAdmin ? 'border-primary' : ''} ${service.isFavorite ? 'ring-1 ring-yellow-500/50' : ''} ${draggedService?.id === service.id ? 'opacity-50' : ''} cursor-grab active:cursor-grabbing`}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {getServiceIcon(service.type)}
                  <CardTitle className="text-lg">{service.name}</CardTitle>
                </div>
                <div className="flex items-center gap-1">
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
                      <Button variant="ghost" size="icon" onClick={() => openEditor(service)} title="Manage Files">
                        <FileText className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openTerminal(getServiceDirectory(service))}
                        title="Open Terminal"
                      >
                        <Terminal className="h-4 w-4" />
                      </Button>
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
                {service.domain}
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
            ))}

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
              <SelectTrigger className="w-[130px]">
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
              <SelectTrigger className="w-[140px]">
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
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {groupedComposeProjects.map((project) => (
              <Card key={project.projectName} className="border-dashed border-purple-500/30">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={`w-3 h-3 rounded-full ${project.isRunning ? 'bg-green-500 animate-pulse' : 'bg-gray-400'}`} />
                      <Boxes className="h-4 w-4 text-purple-500" />
                      <CardTitle className="text-lg">{project.projectName}</CardTitle>
                    </div>
                    {/* Hot command buttons */}
                    <div className="flex gap-1">
                      {/* Start/Stop button */}
                      {project.isRunning ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-yellow-500 hover:text-yellow-600"
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
                          className="h-7 w-7 p-0 text-green-500 hover:text-green-600"
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
                        className="h-7 w-7 p-0 text-blue-500 hover:text-blue-600"
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
                        className="h-7 w-7 p-0 text-red-500 hover:text-red-600"
                        onClick={() => openDestroyDialog(project)}
                        title="Destroy"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                      {/* Terminal button */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => {
                          const firstService = project.services[0];
                          const composeDir = firstService?.composeDir || `/root/docker/${project.projectName}`;
                          openTerminal(composeDir);
                        }}
                        title="Open Terminal"
                      >
                        <Terminal className="h-4 w-4" />
                      </Button>
                      {/* Expand/Collapse button */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
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
                                setFormData({
                                  name: svc.serviceName || svc.containerName,
                                  domain: '',
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

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Service</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{serviceToDelete?.name}"? Enter your TOTP code to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="deleteTotp">TOTP Code</Label>
              <Input id="deleteTotp" value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="Enter 6-digit code" maxLength={6} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDeleteService} disabled={totpCode.length !== 6 || submitting}>
              {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Deleting...</> : 'Delete Service'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Certificate Confirmation Dialog */}
      <Dialog open={removeCertDialogOpen} onOpenChange={setRemoveCertDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove SSL Certificate</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove the SSL certificate for "{serviceToRemoveCert?.domain}"?
              This will disable HTTPS for this service. Enter your TOTP code to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
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
            <Button variant="destructive" onClick={confirmRemoveCertificate} disabled={totpCode.length !== 6 || submitting}>
              {submitting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Removing...</> : 'Remove Certificate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Docker Compose Destroy Dialog */}
      <Dialog open={destroyDialogOpen} onOpenChange={setDestroyDialogOpen}>
        <DialogContent className="max-w-md">
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
              <Label htmlFor="destroyTotp">TOTP Code (required)</Label>
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
              onClick={handleDestroyProject}
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
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Boxes className="h-5 w-5 text-purple-500" />
              Create Docker Compose Service
            </DialogTitle>
            <DialogDescription>
              Define your docker-compose.yml and start the containers
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 flex-1 overflow-auto">
            <div className="space-y-2">
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
            <div className="space-y-2 flex-1">
              <Label>docker-compose.yml</Label>
              <div className="border rounded-md overflow-hidden h-64">
                <CodeMirror
                  value={composeCreateForm.composeContent}
                  height="100%"
                  extensions={[yaml()]}
                  theme={oneDark}
                  onChange={(value) => setComposeCreateForm(prev => ({ ...prev, composeContent: value }))}
                />
              </div>
            </div>

            {/* Environment Variables Section */}
            <div className="space-y-2 border-t pt-4">
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
                    <div key={index} className="flex gap-2 items-center">
                      <Input
                        placeholder="KEY"
                        value={env.key}
                        onChange={(e) => updateEnvVar(index, 'key', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                        className="w-1/3 font-mono text-sm"
                      />
                      <span className="text-muted-foreground">=</span>
                      <Input
                        placeholder="value or {password}"
                        value={env.value}
                        onChange={(e) => updateEnvVar(index, 'value', e.target.value)}
                        className="flex-1 font-mono text-sm"
                      />
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-red-500" onClick={() => removeEnvVar(index)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
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
        <DialogContent className={`${terminalFullscreen ? 'max-w-[100vw] w-screen h-screen max-h-screen m-0 rounded-none' : 'max-w-5xl h-[85vh]'} flex flex-col overflow-hidden`}>
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
            {/* Left Panel: File Browser + Docker Containers */}
            <div className={`${terminalFullscreen ? 'w-72' : 'w-full md:w-64'} shrink-0 flex flex-col gap-2 ${terminalFullscreen ? '' : 'max-h-64 md:max-h-none'}`}>
              {/* Current View - File Browser */}
              <div className="border rounded flex flex-col flex-1 min-h-0">
                <div className="p-2 border-b bg-muted shrink-0 flex items-center justify-between">
                  <span className="font-medium text-sm flex items-center gap-2">
                    <FolderTree className="h-4 w-4" />
                    Current View
                  </span>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => fetchTerminalDirectory(terminalCwd, true)}>
                    <RefreshCw className={`h-3 w-3 ${loadingTerminalFiles ? 'animate-spin' : ''}`} />
                  </Button>
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

            {/* Terminal/Editor Tabbed Panel */}
            <div className="flex-1 flex flex-col border rounded min-h-0">
              {/* Tab Bar */}
              <div className="flex border-b bg-muted shrink-0">
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

              {/* Terminal Tab Content */}
              {terminalActiveTab === 'terminal' && (
                <>
                  <div ref={terminalOutputRef} className="flex-1 bg-black text-green-400 font-mono text-sm p-3 overflow-auto">
                    {terminalOutput.map((line, i) => (
                      <div key={i} className={`whitespace-pre-wrap ${
                        line.type === 'input' ? 'text-cyan-400 font-bold' :
                        line.type === 'error' ? 'text-red-400' :
                        line.type === 'system' ? 'text-blue-400' :
                        'text-green-400'
                      }`}>
                        {String(line.text || '')}
                        {line.duration !== undefined && (
                          <span className="text-gray-500 text-xs ml-2">({line.duration}ms)</span>
                        )}
                      </div>
                    ))}
                    {terminalRunning && (
                      <div className="flex items-center gap-2 text-yellow-400">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Running...
                      </div>
                    )}
                  </div>
                  {/* Tab suggestions */}
                  {showTabSuggestions && tabSuggestions.length > 0 && (
                    <div className="border-t bg-gray-800 p-2 flex flex-wrap gap-1">
                      {tabSuggestions.map((s, i) => (
                        <span
                          key={i}
                          className="text-xs font-mono px-1.5 py-0.5 bg-gray-700 rounded cursor-pointer hover:bg-gray-600 text-cyan-300"
                          onClick={() => {
                            const parts = terminalCommand.split(/\s+/);
                            const lastPart = parts[parts.length - 1] || '';
                            const prefix = lastPart.includes('/') ? lastPart.substring(0, lastPart.lastIndexOf('/') + 1) : '';
                            parts[parts.length - 1] = prefix + s;
                            setTerminalCommand(parts.join(' '));
                            setShowTabSuggestions(false);
                            terminalInputRef.current?.focus();
                          }}
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="border-t p-2 flex gap-2 bg-gray-900">
                    <span className="text-cyan-400 font-mono text-sm shrink-0">{terminalCwd}$</span>
                    <Input
                      ref={terminalInputRef}
                      value={terminalCommand}
                      onChange={(e) => { setTerminalCommand(e.target.value); setShowTabSuggestions(false); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          executeTerminalCommand();
                        } else if (e.key === 'Tab') {
                          e.preventDefault();
                          handleTabComplete();
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          if (commandHistory.length > 0) {
                            const newIndex = historyIndex < commandHistory.length - 1 ? historyIndex + 1 : historyIndex;
                            setHistoryIndex(newIndex);
                            setTerminalCommand(commandHistory[commandHistory.length - 1 - newIndex] || '');
                          }
                        } else if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          if (historyIndex > 0) {
                            const newIndex = historyIndex - 1;
                            setHistoryIndex(newIndex);
                            setTerminalCommand(commandHistory[commandHistory.length - 1 - newIndex] || '');
                          } else if (historyIndex === 0) {
                            setHistoryIndex(-1);
                            setTerminalCommand('');
                          }
                        } else if (e.key === 'Escape') {
                          setShowTabSuggestions(false);
                        }
                      }}
                      placeholder="Enter command... (Tab=complete, ↑↓=history)"
                      className="flex-1 font-mono bg-black text-green-400 border-0 focus-visible:ring-0 h-8"
                      disabled={terminalRunning}
                      autoFocus
                    />
                    {terminalRunning ? (
                      <Button onClick={cancelTerminalCommand} variant="destructive" size="sm">
                        <X className="h-4 w-4 mr-1" />
                        Cancel
                      </Button>
                    ) : (
                      <Button onClick={executeTerminalCommand} disabled={!terminalCommand.trim()} size="sm">
                        Run
                      </Button>
                    )}
                  </div>
                </>
              )}

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

      {/* Full Screen File Editor */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className={`${isFullscreen ? 'max-w-full h-full m-0 rounded-none' : 'max-w-6xl h-[90vh]'} flex flex-col`}>
          <DialogHeader className="shrink-0">
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle>File Editor - {selectedService?.name}</DialogTitle>
                <DialogDescription>View, create, and edit files for your service</DialogDescription>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={exportFiles} title="Export Files">
                  <Download className="h-4 w-4" />
                </Button>
                <label>
                  <input type="file" accept=".json" onChange={importFiles} className="hidden" />
                  <Button variant="outline" size="sm" asChild title="Import Files">
                    <span><Upload className="h-4 w-4" /></span>
                  </Button>
                </label>
                <Button variant="outline" size="sm" onClick={() => setIsFullscreen(!isFullscreen)}>
                  {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </DialogHeader>

          <div className="flex gap-4 flex-1 min-h-0">
            {/* File Tree */}
            <div className="w-64 shrink-0 border rounded flex flex-col">
              <div className="p-2 border-b bg-muted flex items-center justify-between shrink-0">
                <span className="font-medium text-sm">Files</span>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowNewFileInput(true)}>
                  <FilePlus className="h-4 w-4" />
                </Button>
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
              <div className="p-2 border-b bg-muted flex items-center gap-2 shrink-0">
                <span className="font-medium text-sm truncate flex-1">
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
                        <SelectItem value="nginx">NGINX</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="outline" size="sm" onClick={loadVersions} disabled={loadingVersions}>
                      <History className="h-4 w-4 mr-1" />
                      History
                    </Button>
                    {hasUnsavedChanges && (
                      <Input
                        className="w-40 h-7 text-xs"
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

      {/* Export Dialog */}
      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent>
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
        <DialogContent>
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-500">
              <ShieldAlert className="h-5 w-5" />
              Secure System - Kill Switch
            </DialogTitle>
            <DialogDescription>
              This will stop the ProxyPilot admin container. All your services, NGINX configurations,
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
              onClick={handleSecureSystem}
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
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Radar className="h-5 w-5" />
              Discover Existing Sites
            </DialogTitle>
            <DialogDescription>
              Discover and import existing NGINX sites and Docker Compose services from this server.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4 py-4">
            {discoveringNginx ? (
              <div className="flex items-center justify-center p-8">
                <Loader2 className="h-8 w-8 animate-spin" />
                <span className="ml-2">Scanning for sites...</span>
              </div>
            ) : discoveredSites.length === 0 ? (
              <div className="text-center p-8 text-muted-foreground">
                <Radar className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No new sites discovered</p>
                <p className="text-sm">All existing NGINX sites are already imported.</p>
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
                          {site.sslEnabled && <ShieldCheck className="h-4 w-4 text-green-500" />}
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">{site.domain}</p>
                        {site.rootDir && <p className="text-xs text-muted-foreground">Root: {site.rootDir}</p>}
                        {site.port && <p className="text-xs text-muted-foreground">Port: {site.port}</p>}
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
        <DialogContent className="max-w-md">
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
                    <p className="font-medium text-sm">NGINX Config & Files</p>
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
                      <p className="text-xs text-muted-foreground">Let's Encrypt certificate</p>
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
        <DialogContent className="max-w-4xl h-[80vh] flex flex-col">
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
        <DialogContent className="max-w-lg">
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

                <div className="grid grid-cols-2 gap-3">
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
                  <li>NGINX reverse proxy configuration</li>
                  <li>SSL certificate via Let's Encrypt</li>
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
        <DialogContent className="max-w-md">
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
