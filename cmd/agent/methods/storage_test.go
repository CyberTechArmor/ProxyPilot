package methods

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// Every storage test drives the handlers through #!/bin/sh stubs that cat a
// fixture from testdata/storage, swapped in through the package-level
// binary vars. Tests mutate those vars — no t.Parallel.

func storageFixture(t *testing.T, name string) string {
	t.Helper()
	p, err := filepath.Abs(filepath.Join("testdata", "storage", name))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	return p
}

func writeStorageStub(t *testing.T, name, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatalf("write stub %s: %v", name, err)
	}
	return path
}

type storageStubs struct {
	lsblk, smartctl, zpool, zfs, findmnt, swapon string
}

func withStorageBinaries(t *testing.T, s storageStubs) {
	t.Helper()
	prev := storageStubs{lsblkBinary, smartctlBinary, zpoolBinary, zfsBinary, findmntBinary, swaponBinary}
	prevDev := storageDevDir
	set := func(v *string, stub string) {
		if stub != "" {
			*v = stub
		}
	}
	set(&lsblkBinary, s.lsblk)
	set(&smartctlBinary, s.smartctl)
	set(&zpoolBinary, s.zpool)
	set(&zfsBinary, s.zfs)
	set(&findmntBinary, s.findmnt)
	set(&swaponBinary, s.swapon)
	t.Cleanup(func() {
		lsblkBinary, smartctlBinary, zpoolBinary, zfsBinary, findmntBinary, swaponBinary = prev.lsblk, prev.smartctl, prev.zpool, prev.zfs, prev.findmnt, prev.swapon
		storageDevDir = prevDev
	})
}

func missingBinary(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "no-such-binary")
}

// fakeDevTree builds <tmp>/{nvme0n1,sda,…} plus <tmp>/disk/by-id/* symlinks
// laid out exactly like udev does (relative ../../<kname>) and points
// storageDevDir at it.
func fakeDevTree(t *testing.T) string {
	t.Helper()
	dev, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"nvme0n1", "nvme0n1p1", "nvme0n1p2", "nvme0n1p3", "sda", "sda1", "sda9", "sdb", "sdb1", "sdb9", "sdc", "sdd", "sdd1", "dm-0", "dm-1"} {
		if err := os.WriteFile(filepath.Join(dev, n), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	byID := filepath.Join(dev, "disk", "by-id")
	if err := os.MkdirAll(byID, 0o755); err != nil {
		t.Fatal(err)
	}
	links := map[string]string{
		"nvme-Samsung_SSD_980_PRO_1TB_S5GXNX0R123456":       "nvme0n1",
		"nvme-eui.0025385b21b4a1c2":                         "nvme0n1",
		"nvme-Samsung_SSD_980_PRO_1TB_S5GXNX0R123456-part1": "nvme0n1p1",
		"nvme-eui.0025385b21b4a1c2-part1":                   "nvme0n1p1",
		"ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1234567":          "sda",
		"wwn-0x50014ee2b1234567":                            "sda",
		"ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1234567-part1":    "sda1",
		"wwn-0x50014ee2b1234567-part1":                      "sda1",
		"ata-WDC_WD40EFRX-68N32N0_WD-WCC7K7654321":          "sdb",
		"wwn-0x50014ee2b7654321":                            "sdb",
		"wwn-0x50014ee2b7654321-part1":                      "sdb1",
		"ata-ST2000DM008-2FR102_ZFL1ABCD":                   "sdc",
		"wwn-0x5000c500c1234567":                            "sdc",
		"usb-SanDisk_Ultra_4C530001230405111111-0:0":        "sdd",
		"usb-SanDisk_Ultra_4C530001230405111111-0:0-part1":  "sdd1",
		"dm-name-vg0-root":                                  "dm-0",
	}
	for name, target := range links {
		if err := os.Symlink("../../"+target, filepath.Join(byID, name)); err != nil {
			t.Fatal(err)
		}
	}
	// A dangling link (unplugged disk) must be skipped, not crash the scan.
	if err := os.Symlink("../../sdz", filepath.Join(byID, "wwn-0xdead")); err != nil {
		t.Fatal(err)
	}
	storageDevDir = dev
	return dev
}

// defaultStorageStubs is the "everything works as the unprivileged agent"
// host: lsblk/findmnt/swapon/zpool/zfs answer, smartctl only opens the NVMe
// and sda, and the by-id import scan finds one foreign pool.
func defaultStorageStubs(t *testing.T) storageStubs {
	t.Helper()
	return storageStubs{
		lsblk: writeStorageStub(t, "lsblk", `cat "`+storageFixture(t, "lsblk.json")+`"`),
		smartctl: writeStorageStub(t, "smartctl", `case "$3" in
  /dev/nvme0n1) cat "`+storageFixture(t, "smartctl-nvme.json")+`" ;;
  /dev/sda) cat "`+storageFixture(t, "smartctl-sata.json")+`" ;;
  *) cat "`+storageFixture(t, "smartctl-permission.json")+`"; exit 2 ;;
esac`),
		findmnt: writeStorageStub(t, "findmnt", `case "$4" in
  /) echo "/ /dev/mapper/vg0-root ext4" ;;
  /boot) echo "/boot /dev/nvme0n1p2 ext4" ;;
  /boot/efi) echo "/boot/efi /dev/nvme0n1p1 vfat" ;;
  /boot/firmware) echo "/boot /dev/nvme0n1p2 ext4" ;;
  *) exit 1 ;;
esac`),
		swapon: writeStorageStub(t, "swapon", `echo /dev/dm-1`),
		zpool: writeStorageStub(t, "zpool", `case "$1" in
  import) cat "`+storageFixture(t, "zpool-import.txt")+`" ;;
  list) cat "`+storageFixture(t, "zpool-list.txt")+`" ;;
  status) if [ "$2" = "-j" ]; then echo "unrecognized option '-j'" >&2; exit 2; fi; cat "`+storageFixture(t, "zpool-status.txt")+`" ;;
  *) exit 2 ;;
esac`),
		zfs: writeStorageStub(t, "zfs", `case "$5" in
  snapshot) cat "`+storageFixture(t, "zfs-snapshots.txt")+`" ;;
  *) cat "`+storageFixture(t, "zfs-list.txt")+`" ;;
esac`),
	}
}

func s(v *string) string {
	if v == nil {
		return "<nil>"
	}
	return *v
}

func f(v *float64) float64 {
	if v == nil {
		return -1
	}
	return *v
}

func deviceByName(t *testing.T, devs []storageDevice, name string) *storageDevice {
	t.Helper()
	for i := range devs {
		if devs[i].Name == name {
			return &devs[i]
		}
	}
	t.Fatalf("device %s not in %v", name, deviceNames(devs))
	return nil
}

func deviceNames(devs []storageDevice) []string {
	out := make([]string, 0, len(devs))
	for _, d := range devs {
		out = append(out, d.Name)
	}
	return out
}

func localISO(t *testing.T, text string) string {
	t.Helper()
	tm, err := time.ParseInLocation("Mon Jan _2 15:04:05 2006", text, time.Local)
	if err != nil {
		t.Fatal(err)
	}
	return tm.UTC().Format("2006-01-02T15:04:05.000Z")
}

/* ------------------------------ list_disks -------------------------------- */

func TestStorageListDisks(t *testing.T) {
	withStorageBinaries(t, defaultStorageStubs(t))
	fakeDevTree(t)

	raw, err := StorageListDisks(json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("unexpected envelope error: %+v", err)
	}
	res := raw.(storageListDisksResult)

	if got := deviceNames(res.Devices); !reflect.DeepEqual(got, []string{"nvme0n1", "sda", "sdb", "sdc", "sdd"}) {
		t.Fatalf("devices = %v (loop/rom nodes must be skipped)", got)
	}
	if len(res.Warnings) != 0 {
		t.Errorf("warnings = %v, want none", res.Warnings)
	}

	t.Run("nvme OS disk", func(t *testing.T) {
		d := deviceByName(t, res.Devices, "nvme0n1")
		if d.Path != "/dev/nvme0n1" || s(d.Model) != "Samsung SSD 980 PRO 1TB" || s(d.Serial) != "S5GXNX0R123456" || s(d.WWN) != "eui.0025385b21b4a1c2" {
			t.Errorf("identity: %+v", d)
		}
		if d.Vendor != nil || f(d.SizeBytes) != 1000204886016 || s(d.Transport) != "nvme" || d.Rotational || d.Removable || d.ReadOnly {
			t.Errorf("attrs: vendor=%v size=%v tran=%v rota=%v rm=%v ro=%v", d.Vendor, f(d.SizeBytes), s(d.Transport), d.Rotational, d.Removable, d.ReadOnly)
		}
		if d.Fstype != nil || d.Label != nil || s(d.Pttype) != "gpt" || len(d.Mountpoints) != 0 {
			t.Errorf("fs: fstype=%v label=%v pttype=%v mountpoints=%v", d.Fstype, d.Label, s(d.Pttype), d.Mountpoints)
		}
		if len(d.Partitions) != 3 || len(d.Holders) != 0 {
			t.Fatalf("partitions=%d holders=%d", len(d.Partitions), len(d.Holders))
		}
		p1 := d.Partitions[0]
		if p1.Name != "nvme0n1p1" || p1.Path != "/dev/nvme0n1p1" || s(p1.Fstype) != "vfat" || s(p1.UUID) != "1A2B-3C4D" || s(p1.Partlabel) != "EFI System Partition" || s(p1.Parttype) != "c12a7328-f81f-11d2-ba4b-00a0c93ec93b" || f(p1.SizeBytes) != 1127219200 {
			t.Errorf("p1: %+v", p1)
		}
		if !reflect.DeepEqual(p1.Mountpoints, []string{"/boot/efi"}) || p1.Label != nil {
			t.Errorf("p1 mounts=%v label=%v", p1.Mountpoints, p1.Label)
		}
		if got := d.Partitions[1].Mountpoints; !reflect.DeepEqual(got, []string{"/boot"}) {
			t.Errorf("p2 mounts=%v", got)
		}
		p3 := d.Partitions[2]
		if s(p3.Fstype) != "LVM2_member" || len(p3.Mountpoints) != 0 || len(p3.Holders) != 2 {
			t.Fatalf("p3: %+v", p3)
		}
		root := p3.Holders[0]
		if s(root.Name) != "dm-0" || s(root.Type) != "lvm" || s(root.Fstype) != "ext4" || !reflect.DeepEqual(root.Mountpoints, []string{"/"}) {
			t.Errorf("dm-0 holder: %+v", root)
		}
		if swap := p3.Holders[1]; s(swap.Name) != "dm-1" || s(swap.Fstype) != "swap" || !reflect.DeepEqual(swap.Mountpoints, []string{"[SWAP]"}) {
			t.Errorf("dm-1 holder: %+v", swap)
		}
		want := []string{"nvme0n1p1", "nvme0n1p2", "nvme0n1p3", "dm-0", "vg0-root", "dm-1", "vg0-swap"}
		if !reflect.DeepEqual(d.Contains, want) {
			t.Errorf("contains = %v, want %v", d.Contains, want)
		}
		wantID := []string{"/dev/disk/by-id/nvme-Samsung_SSD_980_PRO_1TB_S5GXNX0R123456", "/dev/disk/by-id/nvme-eui.0025385b21b4a1c2"}
		if !reflect.DeepEqual(d.ByID, wantID) {
			t.Errorf("by_id = %v, want %v (bus id before nvme-eui)", d.ByID, wantID)
		}
		wantP1 := []string{"/dev/disk/by-id/nvme-Samsung_SSD_980_PRO_1TB_S5GXNX0R123456-part1", "/dev/disk/by-id/nvme-eui.0025385b21b4a1c2-part1"}
		if !reflect.DeepEqual(p1.ByID, wantP1) {
			t.Errorf("p1 by_id = %v, want %v", p1.ByID, wantP1)
		}
		if len(d.Partitions[1].ByID) != 0 || d.Partitions[1].ByID == nil {
			t.Errorf("p2 by_id must be an empty (non-null) list, got %#v", d.Partitions[1].ByID)
		}
		sm := d.Smart
		if sm == nil || !sm.Available || sm.Healthy == nil || !*sm.Healthy || s(sm.DeviceType) != "nvme" || s(sm.Firmware) != "5B2QGXA7" {
			t.Fatalf("nvme smart: %+v", sm)
		}
		if f(sm.TemperatureC) != 41 || f(sm.PowerOnHours) != 3456 || f(sm.PowerCycles) != 210 || f(sm.PercentageUsed) != 3 || f(sm.MediaErrors) != 0 || f(sm.AvailableSpare) != 100 || f(sm.CriticalWarning) != 0 {
			t.Errorf("nvme counters: %+v", sm)
		}
		if sm.ReallocatedSectors != nil || sm.PendingSectors != nil || sm.Error != nil || sm.ExitStatus != 0 || len(sm.Messages) != 0 {
			t.Errorf("nvme ata fields must be null: %+v", sm)
		}
	})

	t.Run("sata zfs members", func(t *testing.T) {
		d := deviceByName(t, res.Devices, "sda")
		if s(d.Vendor) != "ATA" || s(d.Model) != "WDC WD40EFRX-68N32N0" || s(d.Transport) != "sata" || !d.Rotational || d.Removable || f(d.SizeBytes) != 4000787030016 {
			t.Errorf("sda: %+v", d)
		}
		if len(d.Partitions) != 2 || s(d.Partitions[0].Fstype) != "zfs_member" || s(d.Partitions[0].Label) != "tank" || d.Partitions[1].Fstype != nil {
			t.Errorf("sda partitions: %+v", d.Partitions)
		}
		wantID := []string{"/dev/disk/by-id/wwn-0x50014ee2b1234567", "/dev/disk/by-id/ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1234567"}
		if !reflect.DeepEqual(d.ByID, wantID) {
			t.Errorf("sda by_id = %v, want %v (wwn first)", d.ByID, wantID)
		}
		wantP1 := []string{"/dev/disk/by-id/ata-WDC_WD40EFRX-68N32N0_WD-WCC7K1234567-part1", "/dev/disk/by-id/wwn-0x50014ee2b1234567-part1"}
		if !reflect.DeepEqual(d.Partitions[0].ByID, wantP1) {
			t.Errorf("sda1 by_id = %v, want %v", d.Partitions[0].ByID, wantP1)
		}
		if !reflect.DeepEqual(d.Contains, []string{"sda1", "sda9"}) {
			t.Errorf("sda contains = %v", d.Contains)
		}
		sm := d.Smart
		if sm == nil || !sm.Available || sm.Healthy == nil || !*sm.Healthy || s(sm.DeviceType) != "sat" || s(sm.Serial) != "WD-WCC7K1234567" {
			t.Fatalf("sda smart: %+v", sm)
		}
		if f(sm.ReallocatedSectors) != 0 || f(sm.PendingSectors) != 2 || f(sm.OfflineUncorrectable) != 0 || f(sm.ReportedUncorrectable) != 0 || f(sm.UdmaCrcErrors) != 1 || f(sm.ReallocatedEvents) != 0 {
			t.Errorf("sda ata counters: %+v", sm)
		}
		if f(sm.TemperatureC) != 34 || f(sm.PowerOnHours) != 21345 || f(sm.PowerCycles) != 87 || sm.PercentageUsed != nil {
			t.Errorf("sda smart attrs: %+v", sm)
		}

		sdb := deviceByName(t, res.Devices, "sdb")
		sm = sdb.Smart
		if sm == nil || sm.Available || s(sm.Error) != "permission_denied" || sm.ExitStatus != 2 || len(sm.Messages) != 1 || !strings.Contains(sm.Messages[0], "Permission denied") {
			t.Fatalf("sdb smart must be permission_denied: %+v", sm)
		}
		if sm.Healthy != nil || sm.Model != nil {
			t.Errorf("sdb smart carries no verdict: %+v", sm)
		}
	})

	t.Run("blank and usb disks", func(t *testing.T) {
		sdc := deviceByName(t, res.Devices, "sdc")
		if len(sdc.Partitions) != 0 || sdc.Pttype != nil || sdc.Fstype != nil || len(sdc.Contains) != 0 || s(sdc.Model) != "ST2000DM008-2FR102" {
			t.Errorf("sdc: %+v", sdc)
		}
		if sdc.Partitions == nil || sdc.Contains == nil || sdc.Holders == nil || sdc.Mountpoints == nil {
			t.Errorf("sdc lists must be empty arrays, not null")
		}
		if s(sdc.Smart.Error) != "permission_denied" {
			t.Errorf("sdc smart: %+v", sdc.Smart)
		}
		sdd := deviceByName(t, res.Devices, "sdd")
		if !sdd.Removable || s(sdd.Transport) != "usb" || s(sdd.Vendor) != "SanDisk" || s(sdd.Pttype) != "dos" {
			t.Errorf("sdd: %+v", sdd)
		}
		if len(sdd.Partitions) != 1 || !reflect.DeepEqual(sdd.Partitions[0].Mountpoints, []string{"/mnt/usb"}) || s(sdd.Partitions[0].Label) != "usbdata" || s(sdd.Partitions[0].Parttype) != "0x83" {
			t.Errorf("sdd1: %+v", sdd.Partitions)
		}
		if !reflect.DeepEqual(sdd.ByID, []string{"/dev/disk/by-id/usb-SanDisk_Ultra_4C530001230405111111-0:0"}) {
			t.Errorf("sdd by_id = %v", sdd.ByID)
		}
	})

	t.Run("os mounts", func(t *testing.T) {
		want := []storageMount{
			{Target: "/", Source: "/dev/mapper/vg0-root", Fstype: strVal("ext4")},
			{Target: "/boot", Source: "/dev/nvme0n1p2", Fstype: strVal("ext4")},
			{Target: "/boot/efi", Source: "/dev/nvme0n1p1", Fstype: strVal("vfat")},
			{Target: "swap", Source: "/dev/dm-1", Fstype: strVal("swap")},
		}
		if len(res.Mounts) != len(want) {
			t.Fatalf("mounts = %+v", res.Mounts)
		}
		for i := range want {
			if res.Mounts[i].Target != want[i].Target || res.Mounts[i].Source != want[i].Source || s(res.Mounts[i].Fstype) != s(want[i].Fstype) {
				t.Errorf("mounts[%d] = %+v, want %+v", i, res.Mounts[i], want[i])
			}
		}
	})

	t.Run("importable pools", func(t *testing.T) {
		if len(res.Importable) != 1 {
			t.Fatalf("importable = %+v", res.Importable)
		}
		p := res.Importable[0]
		if p.Name != "olddata" || s(p.ID) != "1122334455667788990" || s(p.State) != "ONLINE" || !strings.HasPrefix(s(p.Status), "The pool was last accessed") || !strings.HasPrefix(s(p.Action), "The pool can be imported") {
			t.Errorf("olddata: %+v", p)
		}
		if !reflect.DeepEqual(p.Devices, []string{"wwn-0x5000c500b9999999-part1", "wwn-0x5000c500b8888888-part1"}) {
			t.Errorf("devices = %v (mirror-0 and the pool row must be excluded)", p.Devices)
		}
	})
}

func TestStorageListDisksSmartFalse(t *testing.T) {
	stubs := defaultStorageStubs(t)
	marker := filepath.Join(t.TempDir(), "smartctl-was-called")
	stubs.smartctl = writeStorageStub(t, "smartctl", `touch "`+marker+`"; exit 2`)
	withStorageBinaries(t, stubs)
	fakeDevTree(t)

	raw, err := StorageListDisks(json.RawMessage(`{"smart":false}`))
	if err != nil {
		t.Fatalf("unexpected envelope error: %+v", err)
	}
	for _, d := range raw.(storageListDisksResult).Devices {
		if d.Smart == nil || d.Smart.Available || s(d.Smart.Error) != "not collected" {
			t.Errorf("%s smart = %+v, want not collected", d.Name, d.Smart)
		}
	}
	if _, err := os.Stat(marker); err == nil {
		t.Errorf("smartctl must not run when smart=false")
	}

	t.Run("include_loop lists loop devices as disks", func(t *testing.T) {
		raw, err := StorageListDisks(json.RawMessage(`{"smart":false,"include_loop":true}`))
		if err != nil {
			t.Fatal(err)
		}
		got := deviceNames(raw.(storageListDisksResult).Devices)
		if !reflect.DeepEqual(got, []string{"loop0", "nvme0n1", "sda", "sdb", "sdc", "sdd"}) {
			t.Errorf("devices = %v", got)
		}
		loop := deviceByName(t, raw.(storageListDisksResult).Devices, "loop0")
		if s(loop.Fstype) != "squashfs" || !loop.ReadOnly || !reflect.DeepEqual(loop.Mountpoints, []string{"/snap/core22/1"}) {
			t.Errorf("loop0: %+v", loop)
		}
	})

	t.Run("params variants", func(t *testing.T) {
		for _, p := range []string{``, `null`, `{"smart":true}`} {
			if _, err := StorageListDisks(json.RawMessage(p)); err != nil {
				t.Errorf("params %q: %+v", p, err)
			}
		}
		if _, err := StorageListDisks(json.RawMessage(`{"smart":"yes"}`)); err == nil || err.Code != "invalid_params" {
			t.Errorf("expected invalid_params, got %+v", err)
		}
	})
}

func TestStorageListDisksImportScan(t *testing.T) {
	t.Run("no pools available is an empty list", func(t *testing.T) {
		stubs := defaultStorageStubs(t)
		stubs.zpool = writeStorageStub(t, "zpool", `if [ "$1" = import ]; then cat "`+storageFixture(t, "zpool-import-none.txt")+`" >&2; exit 1; fi; exit 2`)
		withStorageBinaries(t, stubs)
		fakeDevTree(t)
		raw, err := StorageListDisks(json.RawMessage(`{"smart":false}`))
		if err != nil {
			t.Fatal(err)
		}
		res := raw.(storageListDisksResult)
		if res.Importable == nil || len(res.Importable) != 0 {
			t.Errorf("importable = %#v, want []", res.Importable)
		}
		if len(res.Warnings) != 0 {
			t.Errorf("warnings = %v", res.Warnings)
		}
		blob, _ := json.Marshal(res)
		if !strings.Contains(string(blob), `"importable":[]`) {
			t.Errorf("importable must serialise as []: %s", blob)
		}
	})

	t.Run("scan failure is null plus a warning", func(t *testing.T) {
		stubs := defaultStorageStubs(t)
		stubs.zpool = writeStorageStub(t, "zpool", `echo "cannot discover pools: permission denied" >&2; exit 1`)
		withStorageBinaries(t, stubs)
		fakeDevTree(t)
		raw, err := StorageListDisks(json.RawMessage(`{"smart":false}`))
		if err != nil {
			t.Fatal(err)
		}
		res := raw.(storageListDisksResult)
		if res.Importable != nil {
			t.Errorf("importable = %#v, want nil", res.Importable)
		}
		if len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "permission denied") {
			t.Errorf("warnings = %v", res.Warnings)
		}
		blob, _ := json.Marshal(res)
		if !strings.Contains(string(blob), `"importable":null`) {
			t.Errorf("importable must serialise as null: %s", blob)
		}
	})

	t.Run("zfs not installed skips the scan with a warning", func(t *testing.T) {
		stubs := defaultStorageStubs(t)
		stubs.zpool = missingBinary(t)
		withStorageBinaries(t, stubs)
		fakeDevTree(t)
		raw, err := StorageListDisks(json.RawMessage(`{"smart":false}`))
		if err != nil {
			t.Fatalf("a missing zpool must not be an envelope error: %+v", err)
		}
		res := raw.(storageListDisksResult)
		if res.Importable != nil || len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "not installed") {
			t.Errorf("importable=%v warnings=%v", res.Importable, res.Warnings)
		}
		if len(res.Devices) != 5 {
			t.Errorf("devices still listed without zfs: %v", deviceNames(res.Devices))
		}
	})
}

func TestStorageListDisksSmartctlMissing(t *testing.T) {
	stubs := defaultStorageStubs(t)
	stubs.smartctl = missingBinary(t)
	withStorageBinaries(t, stubs)
	fakeDevTree(t)
	raw, err := StorageListDisks(json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range raw.(storageListDisksResult).Devices {
		if d.Smart.Available || !strings.Contains(s(d.Smart.Error), "not installed") {
			t.Errorf("%s: %+v", d.Name, d.Smart)
		}
	}
}

func TestStorageListDisksLsblk(t *testing.T) {
	t.Run("missing lsblk is an envelope error", func(t *testing.T) {
		stubs := defaultStorageStubs(t)
		stubs.lsblk = missingBinary(t)
		withStorageBinaries(t, stubs)
		_, err := StorageListDisks(json.RawMessage(`{}`))
		if err == nil || err.Code != "lsblk_unavailable" {
			t.Errorf("got %+v", err)
		}
	})

	t.Run("failing lsblk is an envelope error", func(t *testing.T) {
		stubs := defaultStorageStubs(t)
		stubs.lsblk = writeStorageStub(t, "lsblk", `echo "lsblk: cannot open /sys/dev/block" >&2; exit 1`)
		withStorageBinaries(t, stubs)
		_, err := StorageListDisks(json.RawMessage(`{}`))
		if err == nil || err.Code != "lsblk_failed" || !strings.Contains(err.Message, "cannot open") {
			t.Errorf("got %+v", err)
		}
	})

	t.Run("old util-linux retries without MOUNTPOINTS", func(t *testing.T) {
		stubs := defaultStorageStubs(t)
		log := filepath.Join(t.TempDir(), "calls")
		stubs.lsblk = writeStorageStub(t, "lsblk", `echo "$4" >> "`+log+`"
case "$4" in
  *MOUNTPOINTS*) echo "lsblk: unknown column: MOUNTPOINTS" >&2; exit 1 ;;
  *) cat "`+storageFixture(t, "lsblk.json")+`" ;;
esac`)
		withStorageBinaries(t, stubs)
		fakeDevTree(t)
		raw, err := StorageListDisks(json.RawMessage(`{"smart":false}`))
		if err != nil {
			t.Fatal(err)
		}
		if len(raw.(storageListDisksResult).Devices) != 5 {
			t.Errorf("devices after retry: %v", deviceNames(raw.(storageListDisksResult).Devices))
		}
		calls, _ := os.ReadFile(log)
		lines := strings.Split(strings.TrimSpace(string(calls)), "\n")
		if len(lines) != 2 || !strings.Contains(lines[0], "MOUNTPOINTS") || strings.Contains(lines[1], "MOUNTPOINTS") || !strings.Contains(lines[1], "MOUNTPOINT,PKNAME") {
			t.Errorf("lsblk calls = %q", lines)
		}
	})
}

func TestParseLsblkOldUtilLinux(t *testing.T) {
	// util-linux < 2.37: sizes as strings, booleans as "0"/"1", no
	// mountpoints array, model with trailing padding.
	raw := `{"blockdevices": [
	  {"name": "sda", "kname": "sda", "path": "/dev/sda", "type": "disk", "size": "4000787030016", "model": "WDC WD40EFRX  ", "serial": "X", "wwn": null,
	   "vendor": "ATA     ", "tran": "sata", "rota": "1", "rm": "0", "hotplug": "0", "ro": "0", "fstype": null, "label": null, "uuid": null,
	   "mountpoint": null, "pkname": null, "parttype": null, "partlabel": null, "partuuid": null, "pttype": "gpt",
	   "children": [
	     {"name": "sda1", "kname": "sda1", "path": "/dev/sda1", "type": "part", "size": "1024", "fstype": "ext4", "mountpoint": "/data", "rota": "1", "rm": "0", "ro": "0"},
	     {"name": "md0", "kname": "md0", "type": "raid1", "size": "2048", "fstype": "xfs", "mountpoint": "/srv"}
	   ]}
	]}`
	devs, err := parseLsblk([]byte(raw), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(devs) != 1 {
		t.Fatalf("devs = %+v", devs)
	}
	d := devs[0]
	if f(d.SizeBytes) != 4000787030016 || !d.Rotational || d.Removable || d.ReadOnly || s(d.Model) != "WDC WD40EFRX" || s(d.Vendor) != "ATA" {
		t.Errorf("old-style scalars: %+v", d)
	}
	if len(d.Partitions) != 1 || !reflect.DeepEqual(d.Partitions[0].Mountpoints, []string{"/data"}) || f(d.Partitions[0].SizeBytes) != 1024 {
		t.Errorf("partition: %+v", d.Partitions)
	}
	if len(d.Holders) != 1 || s(d.Holders[0].Name) != "md0" || s(d.Holders[0].Type) != "raid1" || !reflect.DeepEqual(d.Holders[0].Mountpoints, []string{"/srv"}) {
		t.Errorf("holder: %+v", d.Holders)
	}
	if !reflect.DeepEqual(d.Contains, []string{"sda1", "md0"}) {
		t.Errorf("contains = %v", d.Contains)
	}
}

func TestStorageDeviceJSONKeys(t *testing.T) {
	withStorageBinaries(t, defaultStorageStubs(t))
	fakeDevTree(t)
	raw, err := StorageListDisks(json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	res := raw.(storageListDisksResult)

	keysOf := func(v any) []string {
		blob, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(blob, &m); err != nil {
			t.Fatal(err)
		}
		out := make([]string, 0, len(m))
		for k := range m {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	expect := func(what string, got, want []string) {
		t.Helper()
		sort.Strings(want)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s keys = %v\nwant %v", what, got, want)
		}
	}

	expect("result", keysOf(res), []string{"devices", "mounts", "importable", "warnings"})
	nvme := *deviceByName(t, res.Devices, "nvme0n1")
	expect("device", keysOf(nvme), []string{"name", "path", "model", "serial", "wwn", "vendor", "size_bytes", "transport", "rotational", "removable", "read_only", "fstype", "label", "pttype", "mountpoints", "partitions", "holders", "contains", "by_id", "smart"})
	expect("partition", keysOf(nvme.Partitions[0]), []string{"name", "path", "size_bytes", "fstype", "label", "uuid", "parttype", "partlabel", "mountpoints", "holders", "by_id"})
	expect("holder", keysOf(nvme.Partitions[2].Holders[0]), []string{"name", "type", "fstype", "mountpoints"})
	expect("smart", keysOf(nvme.Smart), []string{"available", "healthy", "device_type", "model", "serial", "firmware", "temperature_c", "power_on_hours", "power_cycles", "reallocated_sectors", "pending_sectors", "offline_uncorrectable", "reported_uncorrectable", "udma_crc_errors", "percentage_used", "media_errors", "available_spare", "critical_warning", "exit_status", "messages", "error"})
	expect("mount", keysOf(res.Mounts[0]), []string{"target", "source", "fstype"})
	expect("importable", keysOf(res.Importable[0]), []string{"name", "id", "state", "status", "action", "devices"})

	// Null-vs-value rendering the Node side relies on.
	blob, _ := json.Marshal(nvme)
	for _, frag := range []string{`"vendor":null`, `"fstype":null`, `"label":null`, `"size_bytes":1000204886016`, `"rotational":false`, `"mountpoints":[]`, `"holders":[]`} {
		if !strings.Contains(string(blob), frag) {
			t.Errorf("device JSON lacks %s: %s", frag, blob)
		}
	}
	sdc := *deviceByName(t, res.Devices, "sdc")
	blob, _ = json.Marshal(sdc)
	for _, frag := range []string{`"pttype":null`, `"partitions":[]`, `"contains":[]`, `"error":"permission_denied"`, `"healthy":null`, `"temperature_c":null`} {
		if !strings.Contains(string(blob), frag) {
			t.Errorf("sdc JSON lacks %s: %s", frag, blob)
		}
	}
}

/* ----------------------------- zpool_status ------------------------------- */

func TestStorageZpoolStatus(t *testing.T) {
	withStorageBinaries(t, defaultStorageStubs(t))
	raw, err := StorageZpoolStatus(nil)
	if err != nil {
		t.Fatalf("unexpected envelope error: %+v", err)
	}
	res := raw.(storageZpoolStatusResult)
	if res.Error != nil {
		t.Errorf("error = %q", *res.Error)
	}

	t.Run("list", func(t *testing.T) {
		if len(res.List) != 2 {
			t.Fatalf("list = %+v", res.List)
		}
		tank := res.List[0]
		if tank.Name != "tank" || f(tank.SizeBytes) != 3985729650688 || f(tank.AllocatedBytes) != 1234567890123 || f(tank.FreeBytes) != 2751161760565 {
			t.Errorf("tank sizes: %+v", tank)
		}
		if f(tank.FragmentationPct) != 4 || f(tank.CapacityPct) != 30 || s(tank.Health) != "ONLINE" || f(tank.DedupRatio) != 1 || s(tank.GUID) != "12345678901234567890" || tank.Altroot != nil || tank.Readonly || f(tank.Ashift) != 12 {
			t.Errorf("tank attrs: %+v", tank)
		}
		if b := res.List[1]; b.Name != "backup" || s(b.Health) != "DEGRADED" || f(b.CapacityPct) != 50 {
			t.Errorf("backup: %+v", b)
		}
		blob, _ := json.Marshal(tank)
		for _, frag := range []string{`"size_bytes":3985729650688`, `"guid":"12345678901234567890"`, `"altroot":null`, `"dedup_ratio":1`} {
			if !strings.Contains(string(blob), frag) {
				t.Errorf("list JSON lacks %s: %s", frag, blob)
			}
		}
	})

	if len(res.Status) != 2 {
		t.Fatalf("status = %+v", res.Status)
	}

	t.Run("mirror pool after a scrub", func(t *testing.T) {
		p := res.Status[0]
		if p.Name != "tank" || s(p.State) != "ONLINE" || p.Status != nil || p.Action != nil || p.See != nil || p.Checkpoint != nil {
			t.Errorf("tank header: %+v", p)
		}
		if f(p.ErrorCount) != 0 {
			t.Errorf("tank error_count from the text form: %v", f(p.ErrorCount))
		}
		if s(p.Errors) != "No known data errors" || p.ConfigText == nil || !strings.Contains(*p.ConfigText, "mirror-0") {
			t.Errorf("tank errors/config: %v / %v", s(p.Errors), s(p.ConfigText))
		}
		sc := p.Scan
		if sc == nil || s(sc.Function) != "scrub" || sc.State != "finished" || s(sc.Repaired) != "0B" || s(sc.Duration) != "03:12:45" || f(sc.Errors) != 0 || f(sc.Percent) != 100 || sc.ToGo != nil || sc.Started != nil {
			t.Fatalf("tank scan: %+v", sc)
		}
		if want := localISO(t, "Sun Sep 14 00:24:03 2026"); s(sc.LastEnd) != want {
			t.Errorf("last_end = %s, want %s", s(sc.LastEnd), want)
		}
		if !strings.HasPrefix(s(sc.Text), "scrub repaired 0B") {
			t.Errorf("scan text = %s", s(sc.Text))
		}
		if len(p.Vdevs) != 2 {
			t.Fatalf("tank vdevs: %+v", p.Vdevs)
		}
		m := p.Vdevs[0]
		if m.Name != "mirror-0" || m.Type != "mirror" || m.Class != "data" || s(m.State) != "ONLINE" || f(m.ReadErrors) != 0 || len(m.Devices) != 2 {
			t.Errorf("mirror-0: %+v", m)
		}
		leaf := m.Devices[1]
		if leaf.Name != "/dev/disk/by-id/wwn-0x50014ee2b7654321-part1" || s(leaf.Path) != leaf.Name || s(leaf.State) != "ONLINE" || leaf.Class != "data" || leaf.Note != nil || f(leaf.CksumErrors) != 0 {
			t.Errorf("mirror leaf: %+v", leaf)
		}
		lg := p.Vdevs[1]
		if lg.Type != "single" || lg.Class != "logs" || len(lg.Devices) != 1 || lg.Devices[0].Class != "logs" || !strings.HasSuffix(lg.Name, "S5GXNX0R123456-part4") || lg.Devices[0].Name != lg.Name {
			t.Errorf("log vdev: %+v", lg)
		}
	})

	t.Run("degraded raidz1 mid-scrub", func(t *testing.T) {
		p := res.Status[1]
		if p.Name != "backup" || s(p.State) != "DEGRADED" {
			t.Errorf("backup header: %+v", p)
		}
		if s(p.Status) != "One or more devices are faulted in response to persistent errors. Sufficient replicas exist for the pool to continue functioning in a degraded state." {
			t.Errorf("status = %q", s(p.Status))
		}
		if s(p.Action) != "Replace the faulted device, or use 'zpool clear' to mark the device repaired." {
			t.Errorf("action = %q", s(p.Action))
		}
		sc := p.Scan
		if sc == nil || s(sc.Function) != "scrub" || sc.State != "in_progress" || f(sc.Percent) != 25.71 || s(sc.ToGo) != "01:10:52" || s(sc.Repaired) != "0B" || sc.Errors != nil || sc.LastEnd != nil || sc.Duration != nil {
			t.Fatalf("backup scan: %+v", sc)
		}
		if want := localISO(t, "Fri Sep 18 22:10:00 2026"); s(sc.Started) != want {
			t.Errorf("started = %s, want %s", s(sc.Started), want)
		}
		if len(p.Vdevs) != 1 || p.Vdevs[0].Type != "raidz1" || p.Vdevs[0].Name != "raidz1-0" || s(p.Vdevs[0].State) != "DEGRADED" || len(p.Vdevs[0].Devices) != 3 {
			t.Fatalf("backup vdevs: %+v", p.Vdevs)
		}
		bad := p.Vdevs[0].Devices[2]
		if s(bad.State) != "FAULTED" || f(bad.ReadErrors) != 12 || f(bad.WriteErrors) != 0 || f(bad.CksumErrors) != 0 || s(bad.Note) != "too many errors" || s(bad.Path) != "/dev/disk/by-id/wwn-0x5000c500a3333333-part1" {
			t.Errorf("faulted leaf: %+v", bad)
		}
		blob, _ := json.Marshal(p)
		for _, frag := range []string{`"scan":{"function":"scrub","state":"in_progress","last_end":null,"errors":null,"percent":25.71,"to_go":"01:10:52","repaired":"0B"`, `"cksum_errors":0`, `"see":null`, `"checkpoint":null`, `"config_text":"`} {
			if !strings.Contains(string(blob), frag) {
				t.Errorf("pool JSON lacks %s: %s", frag, blob)
			}
		}
	})

	t.Run("result keys", func(t *testing.T) {
		blob, _ := json.Marshal(res)
		var m map[string]json.RawMessage
		_ = json.Unmarshal(blob, &m)
		for _, k := range []string{"list", "status", "error"} {
			if _, ok := m[k]; !ok {
				t.Errorf("missing key %s", k)
			}
		}
		if string(m["error"]) != "null" {
			t.Errorf("error = %s", m["error"])
		}
	})
}

func TestStorageZpoolStatusJSON(t *testing.T) {
	stubs := defaultStorageStubs(t)
	stubs.zpool = writeStorageStub(t, "zpool", `case "$1" in
  list) cat "`+storageFixture(t, "zpool-list.txt")+`" ;;
  status) [ "$2" = "-j" ] && [ "$3" = "--json-int" ] && cat "`+storageFixture(t, "zpool-status.json")+`" ;;
  *) exit 2 ;;
esac`)
	withStorageBinaries(t, stubs)
	raw, err := StorageZpoolStatus(nil)
	if err != nil {
		t.Fatal(err)
	}
	res := raw.(storageZpoolStatusResult)
	if len(res.Status) != 1 {
		t.Fatalf("status = %+v", res.Status)
	}
	p := res.Status[0]
	// error_count: 0 is healthy: it must read like the text form, never as a
	// non-empty "0 data errors" that every consumer treats as a fault.
	if p.Name != "tank" || s(p.State) != "ONLINE" || s(p.Errors) != "No known data errors" || f(p.ErrorCount) != 0 || p.ConfigText != nil {
		t.Errorf("pool: %+v", p)
	}
	if p.Scan == nil || p.Scan.State != "finished" || s(p.Scan.Function) != "scrub" || s(p.Scan.LastEnd) != "2026-09-14T01:04:03.000Z" || s(p.Scan.Started) != "2026-09-13T21:46:39.000Z" || f(p.Scan.Errors) != 0 || p.Scan.Text != nil {
		t.Errorf("scan: %+v", p.Scan)
	}
	if len(p.Vdevs) != 2 || p.Vdevs[0].Name != "mirror-0" || p.Vdevs[0].Type != "mirror" || p.Vdevs[0].Class != "data" || len(p.Vdevs[0].Devices) != 2 {
		t.Fatalf("vdevs: %+v", p.Vdevs)
	}
	if l := p.Vdevs[0].Devices[1]; f(l.WriteErrors) != 3 || s(l.Path) != "/dev/disk/by-id/wwn-0x50014ee2b7654321-part1" || l.Class != "normal" {
		t.Errorf("mirror leaf order/values: %+v", l)
	}
	if sgl := p.Vdevs[1]; sgl.Type != "single" || len(sgl.Devices) != 1 || sgl.Devices[0].Name != sgl.Name || !strings.HasSuffix(sgl.Name, "c1234567-part1") {
		t.Errorf("single vdev: %+v", sgl)
	}

	t.Run("string-typed numbers without --json-int", func(t *testing.T) {
		pools, err := parseZpoolStatusJSON([]byte(`{"pools":{"p":{"name":"p","state":"ONLINE","error_count":"0","scan_stats":{"function":"RESILVER","state":"SCANNING","start_time":"Fri Sep 18 22:10:00 2026","end_time":"0","errors":"0","pct_done":"12.5"},"vdevs":{"p":{"name":"p","vdev_type":"root","vdevs":{"/dev/sdx1":{"name":"/dev/sdx1","vdev_type":"disk","state":"ONLINE","read_errors":"1","write_errors":"0","checksum_errors":"0"}}}}}}}`))
		if err != nil {
			t.Fatal(err)
		}
		sc := pools[0].Scan
		if s(sc.Function) != "resilver" || sc.State != "in_progress" || f(sc.Percent) != 12.5 || sc.LastEnd != nil || s(sc.Started) != localISO(t, "Fri Sep 18 22:10:00 2026") {
			t.Errorf("scan: %+v", sc)
		}
		if v := pools[0].Vdevs; len(v) != 1 || v[0].Type != "single" || f(v[0].Devices[0].ReadErrors) != 1 || s(v[0].Devices[0].Path) != "/dev/sdx1" {
			t.Errorf("vdevs: %+v", v)
		}
	})
}

func TestStorageZpoolStatusUnavailable(t *testing.T) {
	t.Run("zfs not installed", func(t *testing.T) {
		stubs := defaultStorageStubs(t)
		stubs.zpool = missingBinary(t)
		withStorageBinaries(t, stubs)
		raw, err := StorageZpoolStatus(nil)
		if err != nil {
			t.Fatalf("missing zpool must not be an envelope error: %+v", err)
		}
		res := raw.(storageZpoolStatusResult)
		if res.List == nil || len(res.List) != 0 || res.Status == nil || len(res.Status) != 0 || res.Error == nil || !strings.Contains(*res.Error, "not installed") {
			t.Errorf("result = %+v", res)
		}
		blob, _ := json.Marshal(res)
		if !strings.Contains(string(blob), `"list":[]`) || !strings.Contains(string(blob), `"status":[]`) {
			t.Errorf("empty lists must serialise as []: %s", blob)
		}
	})

	t.Run("older zpool list falls back to 9 columns", func(t *testing.T) {
		stubs := defaultStorageStubs(t)
		stubs.zpool = writeStorageStub(t, "zpool", `case "$1" in
  list) case "$5" in *ashift*) echo "bad property list: invalid property 'ashift'" >&2; exit 2 ;; *) printf 'tank\t100\t50\t50\t1\t50\tONLINE\t1.00\t42\n' ;; esac ;;
  status) [ "$2" = "-j" ] && exit 2; cat "`+storageFixture(t, "zpool-status.txt")+`" ;;
esac`)
		withStorageBinaries(t, stubs)
		raw, err := StorageZpoolStatus(nil)
		if err != nil {
			t.Fatal(err)
		}
		res := raw.(storageZpoolStatusResult)
		if res.Error != nil || len(res.List) != 1 || res.List[0].Ashift != nil || res.List[0].Altroot != nil || res.List[0].Readonly || s(res.List[0].GUID) != "42" {
			t.Errorf("result = %+v (error=%v)", res.List, res.Error)
		}
	})

	t.Run("no pools at all", func(t *testing.T) {
		stubs := defaultStorageStubs(t)
		stubs.zpool = writeStorageStub(t, "zpool", `case "$1" in list) exit 0 ;; status) [ "$2" = "-j" ] && exit 2; echo "no pools available"; exit 0 ;; esac`)
		withStorageBinaries(t, stubs)
		raw, err := StorageZpoolStatus(nil)
		if err != nil {
			t.Fatal(err)
		}
		res := raw.(storageZpoolStatusResult)
		if res.Error != nil || len(res.List) != 0 || len(res.Status) != 0 {
			t.Errorf("result = %+v", res)
		}
	})
}

func TestParseScanVariants(t *testing.T) {
	cases := []struct {
		name  string
		lines []string
		want  zpoolScan
	}{
		{"none", []string{"none requested"}, zpoolScan{State: "none", Text: strVal("none requested")}},
		{"empty", nil, zpoolScan{State: "none"}},
		{"resilvered", []string{"resilvered 1.20T in 02:10:00 with 0 errors on Sun Sep 14 00:24:03 2026"}, zpoolScan{Function: strVal("resilver"), State: "finished", Repaired: strVal("1.20T"), Duration: strVal("02:10:00"), Errors: numVal(0), Percent: numVal(100)}},
		{"multi-day scrub", []string{"scrub repaired 0B in 1 days 02:03:04 with 5 errors on Sun Sep 14 00:24:03 2026"}, zpoolScan{Function: strVal("scrub"), State: "finished", Repaired: strVal("0B"), Duration: strVal("1 days 02:03:04"), Errors: numVal(5), Percent: numVal(100)}},
		{"canceled", []string{"scrub canceled on Sun Sep 14 00:24:03 2026"}, zpoolScan{Function: strVal("scrub"), State: "canceled", LastEnd: strVal("Sun Sep 14 00:24:03 2026"), Text: strVal("scrub canceled on Sun Sep 14 00:24:03 2026")}},
		{"unknown", []string{"something new the parser has not seen"}, zpoolScan{State: "unknown", Text: strVal("something new the parser has not seen")}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := parseScan(tc.lines)
			if got.State != tc.want.State || s(got.Function) != s(tc.want.Function) || s(got.Repaired) != s(tc.want.Repaired) || s(got.Duration) != s(tc.want.Duration) || f(got.Errors) != f(tc.want.Errors) || f(got.Percent) != f(tc.want.Percent) {
				t.Errorf("got %+v, want %+v", got, tc.want)
			}
			if tc.want.State == "finished" {
				if s(got.LastEnd) != localISO(t, "Sun Sep 14 00:24:03 2026") {
					t.Errorf("last_end = %s", s(got.LastEnd))
				}
			} else if s(got.LastEnd) != s(tc.want.LastEnd) || s(got.Text) != s(tc.want.Text) {
				t.Errorf("got %+v, want %+v", got, tc.want)
			}
		})
	}
	t.Run("unparsable date keeps the raw text", func(t *testing.T) {
		got := parseScan([]string{"scrub repaired 0B in 00:01:00 with 0 errors on someday"})
		if got.State != "finished" || s(got.LastEnd) != "someday" {
			t.Errorf("got %+v", got)
		}
	})
}

/* -------------------------------- zfs_list -------------------------------- */

func TestStorageZfsList(t *testing.T) {
	withStorageBinaries(t, defaultStorageStubs(t))
	raw, err := StorageZfsList(nil)
	if err != nil {
		t.Fatalf("unexpected envelope error: %+v", err)
	}
	res := raw.(storageZfsListResult)
	if res.Error != nil {
		t.Errorf("error = %q", *res.Error)
	}
	if len(res.Datasets) != 5 || len(res.Snapshots) != 5 {
		t.Fatalf("datasets=%d snapshots=%d", len(res.Datasets), len(res.Snapshots))
	}

	t.Run("datasets", func(t *testing.T) {
		d := res.Datasets[0]
		if d.Name != "tank" || d.Type != "filesystem" || d.Pool != "tank" || f(d.UsedBytes) != 1234567890123 || f(d.AvailableBytes) != 2700000000000 || f(d.ReferencedBytes) != 98304 {
			t.Errorf("tank: %+v", d)
		}
		if d.QuotaBytes != nil || d.RefquotaBytes != nil || d.ReservationBytes != nil || s(d.Compression) != "lz4" || f(d.CompressRatio) != 1.45 || d.Encryption != nil || d.Keystatus != nil || d.Keylocation != nil {
			t.Errorf("tank props: %+v", d)
		}
		if s(d.Mountpoint) != "/tank" || !d.Mounted || s(d.Canmount) != "on" || f(d.RecordsizeBytes) != 131072 || s(d.Atime) != "off" || s(d.Xattr) != "sa" || d.Origin != nil || s(d.Creation) != "2026-09-14T00:04:03.000Z" || d.Readonly || d.VolsizeBytes != nil {
			t.Errorf("tank mount/creation: %+v", d)
		}
		web := res.Datasets[2]
		if web.Pool != "tank" || f(web.QuotaBytes) != 21474836480 || s(web.Canmount) != "noauto" || s(web.Origin) != "tank/incus/images/abc@readonly" || s(web.Creation) != "2026-09-15T01:33:20.000Z" {
			t.Errorf("web: %+v", web)
		}
		vault := res.Datasets[3]
		if s(vault.Encryption) != "aes-256-gcm" || s(vault.Keystatus) != "available" || s(vault.Keylocation) != "prompt" || s(vault.Atime) != "on" || s(vault.Compression) != "zstd" {
			t.Errorf("vault: %+v", vault)
		}
		vol := res.Datasets[4]
		if vol.Type != "volume" || f(vol.VolsizeBytes) != 10737418240 || f(vol.ReservationBytes) != 10737418240 || vol.QuotaBytes != nil || vol.Mounted || vol.RecordsizeBytes != nil || s(vol.Mountpoint) != "-" || s(vol.Canmount) != "-" || s(vol.Atime) != "-" {
			t.Errorf("volume: %+v", vol)
		}
	})

	t.Run("snapshots", func(t *testing.T) {
		kinds := []string{}
		for _, sn := range res.Snapshots {
			kinds = append(kinds, sn.Kind)
		}
		if !reflect.DeepEqual(kinds, []string{"manual", "sanoid", "incus", "proxypilot", "manual"}) {
			t.Errorf("kinds = %v", kinds)
		}
		ro := res.Snapshots[0]
		if ro.Name != "tank/incus/images/abc@readonly" || ro.Dataset != "tank/incus/images/abc" || s(ro.Snapshot) != "readonly" || ro.Pool != "tank" || !reflect.DeepEqual(ro.Clones, []string{"tank/incus/containers/web", "tank/incus/containers/api"}) || ro.Holds != 0 {
			t.Errorf("readonly: %+v", ro)
		}
		auto := res.Snapshots[1]
		if s(auto.Snapshot) != "autosnap_2026-09-18_00:00:01_daily" || s(auto.CreatedAt) != "2026-09-18T00:00:01.000Z" || f(auto.UsedBytes) != 1048576 || f(auto.ReferencedBytes) != 4900000000 || len(auto.Clones) != 0 || auto.Clones == nil {
			t.Errorf("autosnap: %+v", auto)
		}
		pp := res.Snapshots[3]
		if pp.Kind != "proxypilot" || pp.Holds != 1 || s(pp.CreatedAt) != "2026-09-18T20:00:00.000Z" || pp.Dataset != "tank/vault" {
			t.Errorf("pp: %+v", pp)
		}
		if m := res.Snapshots[4]; s(m.Snapshot) != "before-migration" || !reflect.DeepEqual(m.Clones, []string{"tank/vault-clone"}) {
			t.Errorf("manual: %+v", m)
		}
	})

	t.Run("json keys", func(t *testing.T) {
		blob, _ := json.Marshal(res)
		for _, frag := range []string{`"datasets":[`, `"snapshots":[`, `"error":null`, `"quota_bytes":null`, `"compress_ratio":1.45`, `"creation":"2026-09-14T00:04:03.000Z"`, `"created_at":"2026-09-18T00:00:01.000Z"`, `"clones":[]`, `"holds":1`, `"kind":"sanoid"`, `"volsize_bytes":10737418240`, `"recordsize_bytes":131072`, `"mounted":true`} {
			if !strings.Contains(string(blob), frag) {
				t.Errorf("zfs_list JSON lacks %s", frag)
			}
		}
	})
}

func TestStorageZfsListUnavailable(t *testing.T) {
	t.Run("zfs not installed", func(t *testing.T) {
		stubs := defaultStorageStubs(t)
		stubs.zfs = missingBinary(t)
		withStorageBinaries(t, stubs)
		raw, err := StorageZfsList(nil)
		if err != nil {
			t.Fatalf("missing zfs must not be an envelope error: %+v", err)
		}
		res := raw.(storageZfsListResult)
		if res.Error == nil || !strings.Contains(*res.Error, "not installed") || res.Datasets == nil || len(res.Datasets) != 0 || res.Snapshots == nil || len(res.Snapshots) != 0 {
			t.Errorf("result = %+v", res)
		}
		blob, _ := json.Marshal(res)
		if !strings.Contains(string(blob), `"datasets":[]`) || !strings.Contains(string(blob), `"snapshots":[]`) {
			t.Errorf("empty lists must serialise as []: %s", blob)
		}
	})

	t.Run("zfs error text is surfaced", func(t *testing.T) {
		stubs := defaultStorageStubs(t)
		stubs.zfs = writeStorageStub(t, "zfs", `echo "The ZFS modules are not loaded." >&2; exit 1`)
		withStorageBinaries(t, stubs)
		raw, _ := StorageZfsList(nil)
		res := raw.(storageZfsListResult)
		if res.Error == nil || !strings.Contains(*res.Error, "modules are not loaded") || len(res.Datasets) != 0 {
			t.Errorf("result = %+v", res)
		}
	})
}

func TestClassifySnapshotName(t *testing.T) {
	for name, want := range map[string]string{"autosnap_2026-01-01_00:00:00_hourly": "sanoid", "syncoid_host_2026": "syncoid", "snapshot-0": "incus", "pp-restore-1": "proxypilot", "manual": "manual", "": "manual"} {
		if got := classifySnapshotName(name); got != want {
			t.Errorf("%q → %s, want %s", name, got, want)
		}
	}
}

func TestDefaultRegistryHasStorageMethods(t *testing.T) {
	r := DefaultRegistry()
	for _, name := range []string{"storage.list_disks", "storage.zpool_status", "storage.zfs_list"} {
		if _, ok := r.Lookup(name); !ok {
			t.Errorf("DefaultRegistry missing method %q", name)
		}
	}
}
