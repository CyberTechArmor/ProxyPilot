import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
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
} from 'lucide-react';

export default function Dashboard() {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [filesDialogOpen, setFilesDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [serviceToDelete, setServiceToDelete] = useState(null);
  const [selectedService, setSelectedService] = useState(null);
  const [totpCode, setTotpCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Add service wizard state
  const [wizardStep, setWizardStep] = useState(0); // 0 = type selection, 1 = details
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
  });

  // File management state
  const [files, setFiles] = useState([]);
  const [expandedDirs, setExpandedDirs] = useState({});
  const [selectedFile, setSelectedFile] = useState(null);
  const [fileContent, setFileContent] = useState('');
  const [newFileName, setNewFileName] = useState('');
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [savingFile, setSavingFile] = useState(false);

  // Export/Import state
  const [exportServiceIds, setExportServiceIds] = useState([]);
  const [exportIncludeFiles, setExportIncludeFiles] = useState(true);
  const [importData, setImportData] = useState('');
  const [importOverwrite, setImportOverwrite] = useState(false);

  const { toast } = useToast();

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

  useEffect(() => {
    fetchServices();
  }, []);

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
    });
    setWizardStep(0);
  };

  const openDeleteDialog = (service) => {
    setServiceToDelete(service);
    setTotpCode('');
    setDeleteDialogOpen(true);
  };

  // File Management Functions
  const openFilesDialog = async (service) => {
    setSelectedService(service);
    setFiles([]);
    setSelectedFile(null);
    setFileContent('');
    setFilesDialogOpen(true);
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
    try {
      const { content } = await api.getFileContent(selectedService.id, file.path);
      setFileContent(content);
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
      await api.saveFile(selectedService.id, selectedFile.path, fileContent);
      toast({
        title: 'Success',
        description: 'File saved successfully',
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

      // Refresh file list
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

      // Refresh file list
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
      toast({
        title: 'Success',
        description: 'Export downloaded successfully',
      });
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
        description: `Imported: ${result.results.imported.length}, Skipped: ${result.results.skipped.length}, Errors: ${result.results.errors.length}`,
      });
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
      <div key={item.path}>
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
              className="h-6 w-6 opacity-0 group-hover:opacity-100 hover:opacity-100"
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Services</h1>
          <p className="text-muted-foreground">
            Manage your proxy services and domains
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchServices}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button variant="outline" onClick={() => { setExportServiceIds([]); setExportDialogOpen(true); }}>
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
          <Button variant="outline" onClick={() => { setImportData(''); setImportDialogOpen(true); }}>
            <Upload className="h-4 w-4 mr-2" />
            Import
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
                  <Card
                    className="cursor-pointer hover:border-primary transition-colors"
                    onClick={() => handleTypeSelect('static')}
                  >
                    <CardHeader className="text-center pb-2">
                      <FolderOpen className="h-12 w-12 mx-auto text-primary" />
                      <CardTitle className="text-lg">Static Site</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription className="text-center">
                        Serve static HTML, CSS, and JavaScript files
                      </CardDescription>
                    </CardContent>
                  </Card>

                  <Card
                    className="cursor-pointer hover:border-primary transition-colors"
                    onClick={() => handleTypeSelect('docker')}
                  >
                    <CardHeader className="text-center pb-2">
                      <Container className="h-12 w-12 mx-auto text-primary" />
                      <CardTitle className="text-lg">Docker Container</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription className="text-center">
                        Proxy to a Docker container running on a port
                      </CardDescription>
                    </CardContent>
                  </Card>
                </div>
              ) : (
                <form onSubmit={handleAddService} className="space-y-4">
                  <div className="flex items-center gap-2 p-2 bg-muted rounded mb-4">
                    {formData.type === 'static' ? (
                      <FolderOpen className="h-5 w-5 text-primary" />
                    ) : (
                      <Container className="h-5 w-5 text-primary" />
                    )}
                    <span className="font-medium capitalize">{formData.type} Site</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      onClick={() => setWizardStep(0)}
                    >
                      Change
                    </Button>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="name">Service Name</Label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      placeholder="My Application"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="domain">Domain</Label>
                    <Input
                      id="domain"
                      value={formData.domain}
                      onChange={(e) => setFormData({ ...formData, domain: e.target.value })}
                      placeholder="app.example.com"
                      required
                    />
                  </div>

                  {formData.type === 'docker' && (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="containerName">Container Name</Label>
                        <Input
                          id="containerName"
                          value={formData.containerName}
                          onChange={(e) => setFormData({ ...formData, containerName: e.target.value })}
                          placeholder="my-container"
                          required
                        />
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="port">Port</Label>
                        <Input
                          id="port"
                          type="number"
                          value={formData.port}
                          onChange={(e) => setFormData({ ...formData, port: e.target.value })}
                          placeholder="3000"
                          min="1"
                          max="65535"
                          required
                        />
                      </div>

                      <div className="flex items-center justify-between">
                        <Label htmlFor="websocketEnabled">WebSocket Support</Label>
                        <Switch
                          id="websocketEnabled"
                          checked={formData.websocketEnabled}
                          onCheckedChange={(checked) => setFormData({ ...formData, websocketEnabled: checked })}
                        />
                      </div>
                    </>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="maxUploadSize">Max Upload Size</Label>
                    <Input
                      id="maxUploadSize"
                      value={formData.maxUploadSize}
                      onChange={(e) => setFormData({ ...formData, maxUploadSize: e.target.value })}
                      placeholder="1G"
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <Label htmlFor="sslEnabled">SSL Enabled</Label>
                    <Switch
                      id="sslEnabled"
                      checked={formData.sslEnabled}
                      onCheckedChange={(checked) => setFormData({ ...formData, sslEnabled: checked })}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <Label htmlFor="forceHttps">Force HTTPS</Label>
                    <Switch
                      id="forceHttps"
                      checked={formData.forceHttps}
                      onCheckedChange={(checked) => setFormData({ ...formData, forceHttps: checked })}
                    />
                  </div>

                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setAddDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={submitting}>
                      {submitting ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Creating...
                        </>
                      ) : (
                        'Create Service'
                      )}
                    </Button>
                  </DialogFooter>
                </form>
              )}
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Services Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {services.map((service) => (
          <Card key={service.id} className={service.isAdmin ? 'border-primary' : ''}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {getServiceIcon(service.type)}
                  <CardTitle className="text-lg">{service.name}</CardTitle>
                </div>
                <div className="flex items-center gap-1">
                  {!service.isAdmin && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openFilesDialog(service)}
                        title="Manage Files"
                      >
                        <FileText className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => openDeleteDialog(service)}
                        title="Delete Service"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                  {service.isAdmin && (
                    <Shield className="h-5 w-5 text-primary" title="Admin Dashboard" />
                  )}
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
                <div className="flex justify-between">
                  <span className="text-muted-foreground">SSL</span>
                  <span>{service.sslEnabled ? 'Enabled' : 'Disabled'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <span className={`capitalize ${service.status === 'active' ? 'text-green-500' : 'text-red-500'}`}>
                    {service.status}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}

        {services.length === 0 && (
          <div className="col-span-full text-center py-12 text-muted-foreground">
            <Globe className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>No services configured yet.</p>
            <p className="text-sm">Click "Add Service" to create your first site.</p>
          </div>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Service</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{serviceToDelete?.name}"? This action cannot be undone.
              Enter your TOTP code to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="deleteTotp">TOTP Code</Label>
              <Input
                id="deleteTotp"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Enter 6-digit code"
                maxLength={6}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteService}
              disabled={totpCode.length !== 6 || submitting}
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete Service'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Files Management Dialog */}
      <Dialog open={filesDialogOpen} onOpenChange={setFilesDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Manage Files - {selectedService?.name}</DialogTitle>
            <DialogDescription>
              View, create, and edit files for your service
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-4 h-[500px]">
            {/* File Tree */}
            <div className="w-1/3 border rounded overflow-auto">
              <div className="p-2 border-b bg-muted flex items-center justify-between">
                <span className="font-medium text-sm">Files</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => setShowNewFileInput(true)}
                >
                  <FilePlus className="h-4 w-4" />
                </Button>
              </div>
              {showNewFileInput && (
                <div className="p-2 border-b flex gap-2">
                  <Input
                    placeholder="filename.txt"
                    value={newFileName}
                    onChange={(e) => setNewFileName(e.target.value)}
                    className="h-8"
                  />
                  <Button size="sm" onClick={createNewFile} disabled={savingFile}>
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setShowNewFileInput(false); setNewFileName(''); }}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              )}
              <div className="p-2">
                {files.length > 0 ? (
                  renderFileTree(files)
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">No files yet</p>
                )}
              </div>
            </div>

            {/* Editor */}
            <div className="flex-1 flex flex-col border rounded">
              <div className="p-2 border-b bg-muted flex items-center justify-between">
                <span className="font-medium text-sm truncate">
                  {selectedFile ? selectedFile.path : 'Select a file to edit'}
                </span>
                {selectedFile && (
                  <Button size="sm" onClick={saveFile} disabled={savingFile}>
                    {savingFile ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Save className="h-4 w-4 mr-1" />
                        Save
                      </>
                    )}
                  </Button>
                )}
              </div>
              <textarea
                className="flex-1 p-4 font-mono text-sm resize-none bg-background focus:outline-none"
                value={fileContent}
                onChange={(e) => setFileContent(e.target.value)}
                placeholder={selectedFile ? '' : 'Select a file from the tree to view and edit its contents'}
                disabled={!selectedFile}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Export Dialog */}
      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export Services</DialogTitle>
            <DialogDescription>
              Select services to export and download as JSON
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Select Services</Label>
              <div className="border rounded p-2 max-h-48 overflow-auto">
                {services.filter(s => !s.isAdmin).map((service) => (
                  <div
                    key={service.id}
                    className="flex items-center gap-2 p-2 hover:bg-muted rounded cursor-pointer"
                    onClick={() => toggleExportService(service.id)}
                  >
                    <div className={`w-4 h-4 border rounded flex items-center justify-center ${exportServiceIds.includes(service.id) ? 'bg-primary border-primary' : ''}`}>
                      {exportServiceIds.includes(service.id) && <Check className="h-3 w-3 text-primary-foreground" />}
                    </div>
                    <span>{service.name}</span>
                  </div>
                ))}
                {services.filter(s => !s.isAdmin).length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-2">No services to export</p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Leave empty to export all services
              </p>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="includeFiles">Include Files</Label>
              <Switch
                id="includeFiles"
                checked={exportIncludeFiles}
                onCheckedChange={setExportIncludeFiles}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExportDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleExport} disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Exporting...
                </>
              ) : (
                <>
                  <Download className="mr-2 h-4 w-4" />
                  Export
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Dialog */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Services</DialogTitle>
            <DialogDescription>
              Upload a previously exported JSON file to import services
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Upload File</Label>
              <Input
                type="file"
                accept=".json"
                onChange={handleFileUpload}
              />
            </div>
            <div className="space-y-2">
              <Label>Or Paste JSON</Label>
              <textarea
                className="w-full h-32 p-2 border rounded font-mono text-sm"
                value={importData}
                onChange={(e) => setImportData(e.target.value)}
                placeholder='{"services": [...]}'
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="overwrite">Overwrite Existing</Label>
              <Switch
                id="overwrite"
                checked={importOverwrite}
                onCheckedChange={setImportOverwrite}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleImport} disabled={!importData || submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Importing...
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  Import
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
