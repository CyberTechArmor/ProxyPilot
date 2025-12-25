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
    websocketEnabled: false,
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

  // Docker Compose services state
  const [composeServices, setComposeServices] = useState([]);

  // Nano editor state (for terminal intercept)
  const [nanoEditorOpen, setNanoEditorOpen] = useState(false);
  const [nanoFilePath, setNanoFilePath] = useState('');
  const [nanoFileContent, setNanoFileContent] = useState('');
  const [nanoSaving, setNanoSaving] = useState(false);

  const { toast } = useToast();

  // Filtered and sorted services
  const filteredServices = useMemo(() => {
    let result = [...services];

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
  }, [services, searchQuery, filterType, sortBy, showFavoritesOnly]);

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
  const openTerminal = async () => {
    setTerminalOpen(true);
    setTerminalOutput([{ type: 'system', text: 'Terminal ready. Type commands and press Enter.' }]);
    // Fetch system info and containers
    try {
      const [sysInfo, containerList] = await Promise.all([
        api.getSystemInfo().catch(() => null),
        api.listContainers().catch(() => ({ containers: [] })),
      ]);
      setSystemInfo(sysInfo);
      setContainers(containerList.containers || []);
    } catch (e) {
      console.error('Failed to fetch terminal info:', e);
    }
  };

  const executeTerminalCommand = async () => {
    if (!terminalCommand.trim() || terminalRunning) return;

    const cmd = terminalCommand.trim();
    setTerminalOutput(prev => [...prev, { type: 'input', text: `${terminalCwd}$ ${cmd}` }]);
    setTerminalCommand('');

    // Handle special commands locally
    if (cmd === 'clear') {
      setTerminalOutput([]);
      terminalInputRef.current?.focus();
      return;
    }

    // Intercept nano command and open built-in editor
    if (cmd.startsWith('nano ') || cmd === 'nano') {
      const filePath = cmd === 'nano' ? '' : cmd.substring(5).trim();
      if (!filePath) {
        setTerminalOutput(prev => [...prev, { type: 'error', text: 'Usage: nano <filename>' }]);
        terminalInputRef.current?.focus();
        return;
      }

      // Resolve full path based on current directory
      const fullPath = filePath.startsWith('/') ? filePath : `${terminalCwd}/${filePath}`.replace(/\/+/g, '/');
      setNanoFilePath(fullPath);

      // Try to read the file content
      try {
        const result = await api.executeCommand(`cat "${fullPath}" 2>/dev/null || echo ""`, '/');
        setNanoFileContent(result.output || '');
      } catch (e) {
        setNanoFileContent('');
      }

      setNanoEditorOpen(true);
      setTerminalOutput(prev => [...prev, { type: 'system', text: `Opening ${filePath} in ProxyPilot editor...` }]);
      terminalInputRef.current?.focus();
      return;
    }

    setTerminalRunning(true);

    try {
      // Handle cd command - need to track directory
      if (cmd.startsWith('cd ') || cmd === 'cd') {
        const targetDir = cmd === 'cd' ? '~' : cmd.substring(3).trim();
        // Execute cd and pwd to get the new directory
        const cdCmd = `cd ${terminalCwd} && cd ${targetDir} && pwd`;
        const result = await api.executeCommand(cdCmd, '/');
        if (result.success && result.output) {
          const newCwd = result.output.trim();
          setTerminalCwd(newCwd);
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
        const result = await api.executeCommand(cmd, terminalCwd);
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
      setTerminalOutput(prev => [
        ...prev,
        { type: 'error', text: error.message },
      ]);
    } finally {
      setTerminalRunning(false);
      // Re-focus the input after command completes
      setTimeout(() => terminalInputRef.current?.focus(), 0);
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
          <Button variant="outline" onClick={openTerminal}>
            <Terminal className="h-4 w-4 mr-2" />
            Terminal
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
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Add New Service</DialogTitle>
                <DialogDescription>
                  {wizardStep === 0 ? 'Select the type of service to create' : 'Configure your service details'}
                </DialogDescription>
              </DialogHeader>

              {wizardStep === 0 ? (
                <div className="grid grid-cols-2 gap-4 py-4">
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
                      <CardTitle className="text-lg">Docker Container</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription className="text-center">Proxy to a Docker container running on a port</CardDescription>
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
        <span className="text-sm text-muted-foreground">
          {filteredServices.length} service{filteredServices.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Services Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filteredServices.map((service) => (
          <Card key={service.id} className={`${service.isAdmin ? 'border-primary' : ''} ${service.isFavorite ? 'ring-1 ring-yellow-500/50' : ''}`}>
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
                  {!service.isAdmin && (
                    <>
                      <Button variant="ghost" size="icon" onClick={() => openEditor(service)} title="Manage Files">
                        <FileText className="h-4 w-4" />
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
              </div>
            </CardContent>
          </Card>
        ))}

        {filteredServices.length === 0 && (
          <div className="col-span-full text-center py-12 text-muted-foreground">
            <Globe className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>{searchQuery || filterType !== 'all' || showFavoritesOnly ? 'No services match your filters.' : 'No services configured yet.'}</p>
            <p className="text-sm">
              {searchQuery || filterType !== 'all' || showFavoritesOnly
                ? 'Try adjusting your search or filters.'
                : 'Click "Add Service" to create your first site.'}
            </p>
          </div>
        )}
      </div>

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

      {/* Terminal Dialog */}
      <Dialog open={terminalOpen} onOpenChange={setTerminalOpen}>
        <DialogContent className={`${terminalFullscreen ? 'max-w-full h-full m-0 rounded-none' : 'max-w-5xl h-[85vh]'} flex flex-col`}>
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
                  {systemInfo && ` - ${systemInfo.hostname}`}
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

          <div className={`flex ${terminalFullscreen ? 'flex-row' : 'flex-col md:flex-row'} gap-4 flex-1 min-h-0`}>
            {/* Docker Containers Panel */}
            <div className={`${terminalFullscreen ? 'w-72' : 'w-full md:w-64'} shrink-0 border rounded flex flex-col ${terminalFullscreen ? '' : 'max-h-48 md:max-h-none'}`}>
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

            {/* Terminal Output */}
            <div className="flex-1 flex flex-col border rounded min-h-0">
              <div ref={terminalOutputRef} className="flex-1 bg-black text-green-400 font-mono text-sm p-3 overflow-auto">
                {terminalOutput.map((line, i) => (
                  <div key={i} className={`whitespace-pre-wrap ${
                    line.type === 'input' ? 'text-cyan-400 font-bold' :
                    line.type === 'error' ? 'text-red-400' :
                    line.type === 'system' ? 'text-blue-400' :
                    'text-green-400'
                  }`}>
                    {line.text}
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
              <div className="border-t p-2 flex gap-2 bg-gray-900">
                <span className="text-cyan-400 font-mono text-sm shrink-0">{terminalCwd}$</span>
                <Input
                  ref={terminalInputRef}
                  value={terminalCommand}
                  onChange={(e) => setTerminalCommand(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && executeTerminalCommand()}
                  placeholder="Enter command... (type 'clear' to clear output)"
                  className="flex-1 font-mono bg-black text-green-400 border-0 focus-visible:ring-0 h-8"
                  disabled={terminalRunning}
                  autoFocus
                />
                <Button onClick={executeTerminalCommand} disabled={terminalRunning || !terminalCommand.trim()} size="sm">
                  {terminalRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Run'}
                </Button>
              </div>
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
    </div>
  );
}
