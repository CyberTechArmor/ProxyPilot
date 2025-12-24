import { useState, useEffect } from 'react';
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
  Server,
  FolderOpen,
  Container,
  Loader2,
  Shield,
  RefreshCw,
} from 'lucide-react';

export default function Dashboard() {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [serviceToDelete, setServiceToDelete] = useState(null);
  const [totpCode, setTotpCode] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    domain: '',
    type: 'proxy',
    target: '127.0.0.1',
    port: '',
    rootDir: '',
    containerName: '',
    sslEnabled: true,
    forceHttps: true,
    websocketEnabled: false,
    maxUploadSize: '1G',
  });

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

  const handleAddService = async (e) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      await api.createService(formData);
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
      type: 'proxy',
      target: '127.0.0.1',
      port: '',
      rootDir: '',
      containerName: '',
      sslEnabled: true,
      forceHttps: true,
      websocketEnabled: false,
      maxUploadSize: '1G',
    });
  };

  const openDeleteDialog = (service) => {
    setServiceToDelete(service);
    setTotpCode('');
    setDeleteDialogOpen(true);
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
        return `${service.target}:${service.port}`;
      case 'static':
        return service.rootDir;
      case 'docker':
        return service.containerName;
      default:
        return '-';
    }
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
          <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Service
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Add New Service</DialogTitle>
                <DialogDescription>
                  Configure a new proxy service or static site
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={handleAddService} className="space-y-4">
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

                <div className="space-y-2">
                  <Label htmlFor="type">Service Type</Label>
                  <Select
                    value={formData.type}
                    onValueChange={(value) => setFormData({ ...formData, type: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="proxy">Reverse Proxy</SelectItem>
                      <SelectItem value="static">Static Site</SelectItem>
                      <SelectItem value="docker">Docker Container</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {(formData.type === 'proxy' || formData.type === 'docker') && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="target">Target Host</Label>
                      <Input
                        id="target"
                        value={formData.target}
                        onChange={(e) => setFormData({ ...formData, target: e.target.value })}
                        placeholder="127.0.0.1"
                        required={formData.type === 'proxy'}
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
                        required={formData.type === 'proxy'}
                      />
                    </div>
                  </>
                )}

                {formData.type === 'static' && (
                  <div className="space-y-2">
                    <Label htmlFor="rootDir">Root Directory</Label>
                    <Input
                      id="rootDir"
                      value={formData.rootDir}
                      onChange={(e) => setFormData({ ...formData, rootDir: e.target.value })}
                      placeholder="/var/www/mysite"
                      required
                    />
                  </div>
                )}

                {formData.type === 'docker' && (
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

                {(formData.type === 'proxy' || formData.type === 'docker') && (
                  <div className="flex items-center justify-between">
                    <Label htmlFor="websocketEnabled">WebSocket Support</Label>
                    <Switch
                      id="websocketEnabled"
                      checked={formData.websocketEnabled}
                      onCheckedChange={(checked) => setFormData({ ...formData, websocketEnabled: checked })}
                    />
                  </div>
                )}

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
                {service.isAdmin ? (
                  <Shield className="h-5 w-5 text-primary" title="Admin Dashboard" />
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive"
                    onClick={() => openDeleteDialog(service)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
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
                  <span className="font-mono text-xs">{getServiceLocation(service)}</span>
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
            <p className="text-sm">Click "Add Service" to create your first proxy.</p>
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
    </div>
  );
}
