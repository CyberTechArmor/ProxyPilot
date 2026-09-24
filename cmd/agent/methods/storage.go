package methods

// Host storage discovery: storage.list_disks, storage.zpool_status,
// storage.zfs_list.
//
// These are the agent-side twins of admin/backend/src/lib/storage/parse.js
// (the pure parsers) and host.js (the nsenter fallback). The Node backend
// calls the agent first and falls back to the same commands through nsenter
// when the agent is unreachable or lacks a privilege, so every JSON key the
// structs below emit MUST match the objects parse.js builds — the backend
// runs buildDeviceInventory over `devices` as if it had parsed lsblk itself.
//
// The agent is unprivileged (deploy/proxypilot-agent.service: User=
// proxypilot-agent, NoNewPrivileges, ProtectSystem=strict, plus
// SupplementaryGroups=disk so lsblk/zpool can read block-device labels).
// What that means here:
//
//   - lsblk, findmnt, swapon, zpool list/status and zfs list work.
//   - `smartctl -j -a` usually fails with "Permission denied": the smart
//     record for that disk is {available:false, error:"permission_denied"}
//     and the backend fills it in through its root path.
//   - `zpool import -d /dev/disk/by-id` (the scan) may fail: `importable`
//     is null and a warning explains why; the backend then scans itself.
//   - A missing binary (no ZFS on the host, no smartmontools) is never an
//     envelope error: the zfs methods return empty lists with `error` set,
//     list_disks skips those parts with a warning.
//
// No method reads a caller-supplied path. Every command is argv-only.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Package-level so storage_test.go can point each one at a stub script. A
// bare name is resolved through $PATH and then the usual sbin/bin dirs
// (systemd units get a minimal PATH); a value containing "/" is used as-is.
var (
	lsblkBinary    = "lsblk"
	smartctlBinary = "smartctl"
	zpoolBinary    = "zpool"
	zfsBinary      = "zfs"
	findmntBinary  = "findmnt"
	swaponBinary   = "swapon"

	// storageDevDir is where /dev/disk/by-id lives. Tests point it at a
	// temp tree of symlinks; the emitted by-id paths always use the real
	// /dev/disk/by-id prefix because that is what zpool records.
	storageDevDir = "/dev"
)

var storageLookupDirs = []string{"/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"}

// Column sets — keep in step with LSBLK_COLUMNS / ZPOOL_LIST_COLUMNS /
// ZFS_LIST_COLUMNS / ZFS_SNAPSHOT_COLUMNS in parse.js.
var (
	lsblkColumns = []string{
		"NAME", "KNAME", "PATH", "TYPE", "SIZE", "MODEL", "SERIAL", "WWN", "VENDOR", "TRAN", "ROTA", "RM", "HOTPLUG", "RO",
		"FSTYPE", "LABEL", "UUID", "MOUNTPOINT", "MOUNTPOINTS", "PKNAME", "PARTTYPE", "PARTLABEL", "PARTUUID", "PTTYPE",
	}
	zpoolListColumns = []string{"name", "size", "allocated", "free", "fragmentation", "capacity", "health", "dedupratio", "guid", "altroot", "readonly", "ashift"}
	zfsListColumns   = []string{"name", "type", "used", "available", "referenced", "quota", "refquota", "reservation", "compression", "compressratio", "encryption", "keystatus", "keylocation", "mountpoint", "mounted", "canmount", "recordsize", "atime", "xattr", "origin", "creation", "readonly", "volsize"}
	// createtxg last: the canonical snapshot ordering (creation is whole seconds).
	zfsSnapshotColumns = []string{"name", "creation", "used", "referenced", "clones", "defer_destroy", "userrefs", "createtxg"}
	osMountTargets     = []string{"/", "/boot", "/boot/efi", "/boot/firmware"}
)

const (
	storageTimeoutShort  = 10 * time.Second
	storageTimeoutMedium = 30 * time.Second
	storageTimeoutLong   = 120 * time.Second
	storageStderrTail    = 300
)

/* ------------------------------ result shapes ----------------------------- */

// storageDevice is one whole disk: parseLsblk's disk object plus the
// by_id / smart fields host.js attaches before buildDeviceInventory.
type storageDevice struct {
	Name        string             `json:"name"`
	Path        string             `json:"path"`
	Model       *string            `json:"model"`
	Serial      *string            `json:"serial"`
	WWN         *string            `json:"wwn"`
	Vendor      *string            `json:"vendor"`
	SizeBytes   *float64           `json:"size_bytes"`
	Transport   *string            `json:"transport"`
	Rotational  bool               `json:"rotational"`
	Removable   bool               `json:"removable"`
	ReadOnly    bool               `json:"read_only"`
	Fstype      *string            `json:"fstype"`
	Label       *string            `json:"label"`
	Pttype      *string            `json:"pttype"`
	Mountpoints []string           `json:"mountpoints"`
	Partitions  []storagePartition `json:"partitions"`
	Holders     []storageHolder    `json:"holders"`
	Contains    []string           `json:"contains"`
	ByID        []string           `json:"by_id"`
	Smart       *smartRecord       `json:"smart"`
}

type storagePartition struct {
	Name        string          `json:"name"`
	Path        string          `json:"path"`
	SizeBytes   *float64        `json:"size_bytes"`
	Fstype      *string         `json:"fstype"`
	Label       *string         `json:"label"`
	UUID        *string         `json:"uuid"`
	Parttype    *string         `json:"parttype"`
	Partlabel   *string         `json:"partlabel"`
	Mountpoints []string        `json:"mountpoints"`
	Holders     []storageHolder `json:"holders"`
	ByID        []string        `json:"by_id"`
}

type storageHolder struct {
	Name        *string  `json:"name"`
	Type        *string  `json:"type"`
	Fstype      *string  `json:"fstype"`
	Mountpoints []string `json:"mountpoints"`
}

// smartRecord mirrors parseSmartctl's output.
type smartRecord struct {
	Available             bool     `json:"available"`
	Healthy               *bool    `json:"healthy"`
	DeviceType            *string  `json:"device_type"`
	Model                 *string  `json:"model"`
	Serial                *string  `json:"serial"`
	Firmware              *string  `json:"firmware"`
	TemperatureC          *float64 `json:"temperature_c"`
	PowerOnHours          *float64 `json:"power_on_hours"`
	PowerCycles           *float64 `json:"power_cycles"`
	ReallocatedSectors    *float64 `json:"reallocated_sectors"`
	ReallocatedEvents     *float64 `json:"reallocated_events,omitempty"`
	PendingSectors        *float64 `json:"pending_sectors"`
	OfflineUncorrectable  *float64 `json:"offline_uncorrectable"`
	ReportedUncorrectable *float64 `json:"reported_uncorrectable"`
	UdmaCrcErrors         *float64 `json:"udma_crc_errors"`
	PercentageUsed        *float64 `json:"percentage_used"`
	MediaErrors           *float64 `json:"media_errors"`
	AvailableSpare        *float64 `json:"available_spare"`
	CriticalWarning       *float64 `json:"critical_warning"`
	ExitStatus            int      `json:"exit_status"`
	Messages              []string `json:"messages"`
	Error                 *string  `json:"error"`
}

type storageMount struct {
	Target string  `json:"target"`
	Source string  `json:"source"`
	Fstype *string `json:"fstype"`
}

type zpoolImportable struct {
	Name    string   `json:"name"`
	ID      *string  `json:"id"`
	State   *string  `json:"state"`
	Status  *string  `json:"status"`
	Action  *string  `json:"action"`
	Devices []string `json:"devices"`
}

type storageListDisksResult struct {
	Devices    []storageDevice   `json:"devices"`
	Mounts     []storageMount    `json:"mounts"`
	Importable []zpoolImportable `json:"importable"` // nil → null: the scan could not run
	Warnings   []string          `json:"warnings"`
}

type zpoolListRow struct {
	Name             string   `json:"name"`
	SizeBytes        *float64 `json:"size_bytes"`
	AllocatedBytes   *float64 `json:"allocated_bytes"`
	FreeBytes        *float64 `json:"free_bytes"`
	FragmentationPct *float64 `json:"fragmentation_pct"`
	CapacityPct      *float64 `json:"capacity_pct"`
	Health           *string  `json:"health"`
	DedupRatio       *float64 `json:"dedup_ratio"`
	GUID             *string  `json:"guid"`
	Altroot          *string  `json:"altroot"`
	Readonly         bool     `json:"readonly"`
	Ashift           *float64 `json:"ashift"`
}

type zpoolScan struct {
	Function *string  `json:"function"`
	State    string   `json:"state"`
	LastEnd  *string  `json:"last_end"`
	Errors   *float64 `json:"errors"`
	Percent  *float64 `json:"percent"`
	ToGo     *string  `json:"to_go"`
	Repaired *string  `json:"repaired"`
	Text     *string  `json:"text"`
	Duration *string  `json:"duration,omitempty"`
	Started  *string  `json:"started,omitempty"`
}

type zpoolVdevLeaf struct {
	Name        string   `json:"name"`
	Path        *string  `json:"path"`
	State       *string  `json:"state"`
	ReadErrors  *float64 `json:"read_errors"`
	WriteErrors *float64 `json:"write_errors"`
	CksumErrors *float64 `json:"cksum_errors"`
	Note        *string  `json:"note"`
	Class       string   `json:"class"`
}

type zpoolVdevGroup struct {
	Name        string          `json:"name"`
	Type        string          `json:"type"`
	State       *string         `json:"state"`
	ReadErrors  *float64        `json:"read_errors"`
	WriteErrors *float64        `json:"write_errors"`
	CksumErrors *float64        `json:"cksum_errors"`
	Class       string          `json:"class"`
	Devices     []zpoolVdevLeaf `json:"devices"`
	indent      int
}

type zpoolPool struct {
	Name       string           `json:"name"`
	State      *string          `json:"state"`
	Status     *string          `json:"status"`
	Action     *string          `json:"action"`
	See        *string          `json:"see"`
	Scan       *zpoolScan       `json:"scan"`
	ErrorCount *float64         `json:"error_count"`
	Errors     *string          `json:"errors"`
	Vdevs      []zpoolVdevGroup `json:"vdevs"`
	ConfigText *string          `json:"config_text"`
	Checkpoint *string          `json:"checkpoint"`
}

type storageZpoolStatusResult struct {
	List   []zpoolListRow `json:"list"`
	Status []zpoolPool    `json:"status"`
	Error  *string        `json:"error"`
}

type zfsDataset struct {
	Name             string   `json:"name"`
	Type             string   `json:"type"`
	Pool             string   `json:"pool"`
	UsedBytes        *float64 `json:"used_bytes"`
	AvailableBytes   *float64 `json:"available_bytes"`
	ReferencedBytes  *float64 `json:"referenced_bytes"`
	QuotaBytes       *float64 `json:"quota_bytes"`
	RefquotaBytes    *float64 `json:"refquota_bytes"`
	ReservationBytes *float64 `json:"reservation_bytes"`
	Compression      *string  `json:"compression"`
	CompressRatio    *float64 `json:"compress_ratio"`
	Encryption       *string  `json:"encryption"`
	Keystatus        *string  `json:"keystatus"`
	Keylocation      *string  `json:"keylocation"`
	Mountpoint       *string  `json:"mountpoint"`
	Mounted          bool     `json:"mounted"`
	Canmount         *string  `json:"canmount"`
	RecordsizeBytes  *float64 `json:"recordsize_bytes"`
	Atime            *string  `json:"atime"`
	Xattr            *string  `json:"xattr"`
	Origin           *string  `json:"origin"`
	Creation         *string  `json:"creation"`
	Readonly         bool     `json:"readonly"`
	VolsizeBytes     *float64 `json:"volsize_bytes"`
}

type zfsSnapshot struct {
	Name            string   `json:"name"`
	Dataset         string   `json:"dataset"`
	Snapshot        *string  `json:"snapshot"`
	Pool            string   `json:"pool"`
	CreatedAt       *string  `json:"created_at"`
	UsedBytes       *float64 `json:"used_bytes"`
	ReferencedBytes *float64 `json:"referenced_bytes"`
	Clones          []string `json:"clones"`
	Holds           float64  `json:"holds"`
	CreateTxg       *float64 `json:"createtxg"`
	Kind            string   `json:"kind"`
}

type storageZfsListResult struct {
	Datasets  []zfsDataset  `json:"datasets"`
	Snapshots []zfsSnapshot `json:"snapshots"`
	Error     *string       `json:"error"`
}

/* --------------------------------- exec ----------------------------------- */

var errStorageNotInstalled = errors.New("not installed")

type storageRun struct {
	stdout string
	stderr string
	status int
}

func resolveStorageBinary(bin string) (string, error) {
	if strings.Contains(bin, "/") {
		if st, err := os.Stat(bin); err != nil || st.IsDir() {
			return "", errStorageNotInstalled
		}
		return bin, nil
	}
	if p, err := exec.LookPath(bin); err == nil {
		return p, nil
	}
	for _, d := range storageLookupDirs {
		p := filepath.Join(d, bin)
		if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", errStorageNotInstalled
}

// runStorage executes bin with argv (no shell) under a timeout. A non-zero
// exit is NOT an error: it comes back in status so each caller can decide
// what it means (zpool import exits 1 for "nothing to import"). err is set
// only when the command could not run at all (missing binary, exec
// failure, timeout).
func runStorage(bin string, timeout time.Duration, args ...string) (storageRun, error) {
	path, err := resolveStorageBinary(bin)
	if err != nil {
		return storageRun{}, err
	}
	out, errb, runErr := runBounded(timeout, path, args...)
	r := storageRun{stdout: string(out), stderr: string(errb)}
	if runErr == nil {
		return r, nil
	}
	var ee *exec.ExitError
	if errors.As(runErr, &ee) {
		r.status = ee.ExitCode()
		if r.status == 0 {
			r.status = -1
		}
		return r, nil
	}
	return r, runErr
}

func stderrTail(r storageRun) string {
	s := strings.TrimSpace(r.stderr)
	if s == "" {
		s = strings.TrimSpace(r.stdout)
	}
	if len(s) > storageStderrTail {
		s = s[len(s)-storageStderrTail:]
	}
	return s
}

/* -------------------------------- helpers --------------------------------- */

// strP is parse.js str(): trimmed, empty → null.
func strP(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}

func strVal(s string) *string { return &s }

func f64Val(n float64) *float64 { return &n }

// numP is parse.js num(): ”, '-' and non-numbers → null.
func numP(s string) *float64 {
	s = strings.TrimSpace(s)
	if s == "" || s == "-" {
		return nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	return &f
}

func numVal(f float64) *float64 { return &f }

// numOrNull is parse.js `num(x) || null`: 0 collapses to null.
func numOrNull(s string) *float64 {
	f := numP(s)
	if f == nil || *f == 0 {
		return nil
	}
	return f
}

// boolS is parse.js bool() on a string.
func boolS(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func cell(cells []string, i int) string {
	if i < len(cells) {
		return cells[i]
	}
	return ""
}

// tsvRows splits `-H` (tab-separated, no header) output into cells.
func tsvRows(text string) [][]string {
	var rows [][]string
	for _, l := range strings.Split(text, "\n") {
		l = strings.TrimRight(l, "\r")
		if strings.TrimSpace(l) == "" {
			continue
		}
		rows = append(rows, strings.Split(l, "\t"))
	}
	return rows
}

// epochISO renders epoch seconds the way JS Date#toISOString does.
func epochISO(sec float64) string {
	whole := int64(sec)
	nsec := int64((sec - float64(whole)) * 1e9)
	return time.Unix(whole, nsec).UTC().Format("2006-01-02T15:04:05.000Z")
}

func epochISOFromCell(s string) *string {
	f := numP(s)
	if f == nil {
		return nil
	}
	return strVal(epochISO(*f))
}

var zpoolDateLayouts = []string{
	"Mon Jan _2 15:04:05 2006",
	"Mon Jan _2 15:04:05 MST 2006",
	time.RFC3339,
	time.RFC3339Nano,
	"2006-01-02 15:04:05",
}

// zpoolDateISO parses the `on Sun Sep 14 00:24:03 2026` style dates zpool
// prints (host-local time, like JS `new Date(text)`) into RFC3339 UTC.
func zpoolDateISO(s string) (string, bool) {
	s = strings.TrimSpace(s)
	for _, layout := range zpoolDateLayouts {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t.UTC().Format("2006-01-02T15:04:05.000Z"), true
		}
	}
	return s, false
}

// jsonScalar accepts a JSON string, number, bool or null: lsblk -b emits
// sizes as numbers in new util-linux and strings in old ones, booleans as
// true/false or "0"/"1"; smartctl and zpool -j are similarly loose.
type jsonScalar struct {
	raw []byte
}

func (s *jsonScalar) UnmarshalJSON(b []byte) error {
	s.raw = append([]byte(nil), b...)
	return nil
}

func (s jsonScalar) isNull() bool {
	t := bytes.TrimSpace(s.raw)
	return len(t) == 0 || bytes.Equal(t, []byte("null"))
}

// text is the scalar as a string (no trimming), "" for null.
func (s jsonScalar) text() string {
	if s.isNull() {
		return ""
	}
	t := bytes.TrimSpace(s.raw)
	if t[0] == '"' {
		var str string
		if err := json.Unmarshal(t, &str); err == nil {
			return str
		}
		return ""
	}
	return string(t)
}

func (s jsonScalar) str() *string  { return strP(s.text()) }
func (s jsonScalar) num() *float64 { return numP(s.text()) }
func (s jsonScalar) boolean() bool { return boolS(s.text()) }

/* ------------------------------- lsblk -J --------------------------------- */

type lsblkRoot struct {
	Blockdevices []lsblkNode `json:"blockdevices"`
}

type lsblkNode struct {
	Name        jsonScalar   `json:"name"`
	Kname       jsonScalar   `json:"kname"`
	Path        jsonScalar   `json:"path"`
	Type        jsonScalar   `json:"type"`
	Size        jsonScalar   `json:"size"`
	Model       jsonScalar   `json:"model"`
	Serial      jsonScalar   `json:"serial"`
	WWN         jsonScalar   `json:"wwn"`
	Vendor      jsonScalar   `json:"vendor"`
	Tran        jsonScalar   `json:"tran"`
	Rota        jsonScalar   `json:"rota"`
	RM          jsonScalar   `json:"rm"`
	Hotplug     jsonScalar   `json:"hotplug"`
	RO          jsonScalar   `json:"ro"`
	Fstype      jsonScalar   `json:"fstype"`
	Label       jsonScalar   `json:"label"`
	UUID        jsonScalar   `json:"uuid"`
	Mountpoint  jsonScalar   `json:"mountpoint"`
	Mountpoints []jsonScalar `json:"mountpoints"`
	Parttype    jsonScalar   `json:"parttype"`
	Partlabel   jsonScalar   `json:"partlabel"`
	Pttype      jsonScalar   `json:"pttype"`
	Children    []lsblkNode  `json:"children"`
}

func (n *lsblkNode) kernelName() string {
	if k := n.Kname.str(); k != nil {
		return *k
	}
	if k := n.Name.str(); k != nil {
		return *k
	}
	return ""
}

func (n *lsblkNode) devPath() string {
	if p := n.Path.str(); p != nil {
		return *p
	}
	return "/dev/" + n.kernelName()
}

func (n *lsblkNode) mountpointList() []string {
	out := []string{}
	for _, m := range n.Mountpoints {
		if s := m.text(); s != "" {
			out = append(out, s)
		}
	}
	if mp := n.Mountpoint.text(); mp != "" {
		found := false
		for _, s := range out {
			if s == mp {
				found = true
				break
			}
		}
		if !found {
			out = append(out, mp)
		}
	}
	return out
}

func holderOf(n *lsblkNode) storageHolder {
	return storageHolder{Name: strP(n.kernelName()), Type: n.Type.str(), Fstype: n.Fstype.str(), Mountpoints: n.mountpointList()}
}

// parseLsblk is parse.js parseLsblk: whole disks only (loop devices too when
// includeLoop is set, for the loop-device integration test and dev VMs),
// `part` children as partitions, anything else as a holder, plus every
// kernel and mapper name below the disk in `contains`.
func parseLsblk(raw []byte, includeLoop bool) ([]storageDevice, error) {
	var root lsblkRoot
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, err
	}
	devices := []storageDevice{}
	for i := range root.Blockdevices {
		node := &root.Blockdevices[i]
		if typ := node.Type.text(); typ != "disk" && !(includeLoop && typ == "loop") {
			continue
		}
		disk := storageDevice{
			Name: node.kernelName(), Path: node.devPath(),
			Model: node.Model.str(), Serial: node.Serial.str(), WWN: node.WWN.str(), Vendor: node.Vendor.str(),
			SizeBytes: node.Size.num(), Transport: node.Tran.str(), Rotational: node.Rota.boolean(),
			Removable: node.RM.boolean() || node.Hotplug.boolean(), ReadOnly: node.RO.boolean(),
			Fstype: node.Fstype.str(), Label: node.Label.str(), Pttype: node.Pttype.str(),
			Mountpoints: node.mountpointList(), Partitions: []storagePartition{}, Holders: []storageHolder{}, Contains: []string{}, ByID: []string{},
		}
		for j := range node.Children {
			child := &node.Children[j]
			if child.Type.text() == "part" {
				part := storagePartition{
					Name: child.kernelName(), Path: child.devPath(), SizeBytes: child.Size.num(),
					Fstype: child.Fstype.str(), Label: child.Label.str(), UUID: child.UUID.str(),
					Parttype: child.Parttype.str(), Partlabel: child.Partlabel.str(),
					Mountpoints: child.mountpointList(), Holders: []storageHolder{}, ByID: []string{},
				}
				for k := range child.Children {
					part.Holders = append(part.Holders, holderOf(&child.Children[k]))
				}
				disk.Partitions = append(disk.Partitions, part)
			} else {
				disk.Holders = append(disk.Holders, holderOf(child))
			}
		}
		seen := map[string]bool{}
		var walk func(n *lsblkNode)
		walk = func(n *lsblkNode) {
			// Both the kernel name (dm-0) and the mapper name (vg0-root):
			// findmnt reports "/" as /dev/mapper/vg0-root, and the backend
			// resolves that to a disk through `contains`.
			for _, kp := range []*string{n.Kname.str(), n.Name.str()} {
				if kp == nil {
					continue
				}
				if k := *kp; k != disk.Name && !seen[k] {
					seen[k] = true
					disk.Contains = append(disk.Contains, k)
				}
			}
			for c := range n.Children {
				walk(&n.Children[c])
			}
		}
		walk(node)
		devices = append(devices, disk)
	}
	return devices, nil
}

func lsblkDevices(includeLoop bool) ([]storageDevice, error) {
	r, err := runStorage(lsblkBinary, storageTimeoutMedium, "-J", "-b", "-o", strings.Join(lsblkColumns, ","))
	if err != nil {
		return nil, err
	}
	if r.status != 0 {
		// Older util-linux lacks MOUNTPOINTS.
		cols := make([]string, 0, len(lsblkColumns))
		for _, c := range lsblkColumns {
			if c != "MOUNTPOINTS" {
				cols = append(cols, c)
			}
		}
		r2, err2 := runStorage(lsblkBinary, storageTimeoutMedium, "-J", "-b", "-o", strings.Join(cols, ","))
		if err2 != nil {
			return nil, err2
		}
		if r2.status != 0 {
			tail := stderrTail(r2)
			if tail == "" {
				tail = stderrTail(r)
			}
			return nil, fmt.Errorf("lsblk failed: %s", tail)
		}
		r = r2
	}
	devs, err := parseLsblk([]byte(r.stdout), includeLoop)
	if err != nil {
		return nil, fmt.Errorf("lsblk output was not JSON: %v", err)
	}
	return devs, nil
}

/* ---------------------------- /dev/disk/by-id ----------------------------- */

// byIDRank is parse.js byIdPreference: wwn- first, then bus ids, nvme-eui
// later, -partN last.
func byIDRank(link string) int {
	n := strings.TrimPrefix(link, "/dev/disk/by-id/")
	if partSuffixRe.MatchString(n) {
		return 9
	}
	if strings.HasPrefix(n, "wwn-") {
		return 0
	}
	if strings.HasPrefix(n, "nvme-eui.") {
		return 5
	}
	for _, p := range []string{"ata-", "scsi-", "nvme-", "usb-", "virtio-"} {
		if strings.HasPrefix(n, p) {
			return 1
		}
	}
	return 4
}

var partSuffixRe = regexp.MustCompile(`-part\d+$`)

// byIDMap resolves every /dev/disk/by-id/* symlink (readlink -f) and groups
// the links by the /dev path they point at, sorted by byIDRank.
func byIDMap() map[string][]string {
	out := map[string][]string{}
	dir := filepath.Join(storageDevDir, "disk", "by-id")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	for _, e := range entries {
		link := filepath.Join(dir, e.Name())
		target, err := os.Readlink(link)
		if err != nil {
			continue
		}
		if !filepath.IsAbs(target) {
			target = filepath.Clean(filepath.Join(dir, target))
		}
		if real, err := filepath.EvalSymlinks(target); err == nil {
			target = real
		}
		if rel, err := filepath.Rel(storageDevDir, target); err == nil && rel != "." && !strings.HasPrefix(rel, "..") {
			target = "/dev/" + filepath.ToSlash(rel)
		}
		out[target] = append(out[target], "/dev/disk/by-id/"+e.Name())
	}
	for k := range out {
		links := out[k]
		sort.Slice(links, func(i, j int) bool {
			ri, rj := byIDRank(links[i]), byIDRank(links[j])
			if ri != rj {
				return ri < rj
			}
			return links[i] < links[j]
		})
	}
	return out
}

/* ------------------------------- smartctl -j ------------------------------ */

type smartctlJSON struct {
	Smartctl struct {
		ExitStatus jsonScalar `json:"exit_status"`
		Messages   []struct {
			String string `json:"string"`
		} `json:"messages"`
	} `json:"smartctl"`
	Device struct {
		Type jsonScalar `json:"type"`
	} `json:"device"`
	ModelName       jsonScalar `json:"model_name"`
	SerialNumber    jsonScalar `json:"serial_number"`
	FirmwareVersion jsonScalar `json:"firmware_version"`
	Temperature     *struct {
		Current jsonScalar `json:"current"`
	} `json:"temperature"`
	PowerOnTime *struct {
		Hours jsonScalar `json:"hours"`
	} `json:"power_on_time"`
	PowerCycleCount jsonScalar `json:"power_cycle_count"`
	SmartStatus     *struct {
		Passed *bool `json:"passed"`
	} `json:"smart_status"`
	SmartSupport *struct {
		Available *bool `json:"available"`
	} `json:"smart_support"`
	ATASmartAttributes *struct {
		Table []struct {
			ID  jsonScalar `json:"id"`
			Raw struct {
				Value jsonScalar `json:"value"`
			} `json:"raw"`
		} `json:"table"`
	} `json:"ata_smart_attributes"`
	NVMeLog *struct {
		PercentageUsed  jsonScalar `json:"percentage_used"`
		MediaErrors     jsonScalar `json:"media_errors"`
		AvailableSpare  jsonScalar `json:"available_spare"`
		CriticalWarning jsonScalar `json:"critical_warning"`
		Temperature     jsonScalar `json:"temperature"`
		PowerOnHours    jsonScalar `json:"power_on_hours"`
	} `json:"nvme_smart_health_information_log"`
}

var smartPermissionRe = regexp.MustCompile(`(?i)permission denied|operation not permitted`)

func smartUnavailable(reason string) *smartRecord {
	return &smartRecord{Available: false, Messages: []string{}, Error: strVal(reason)}
}

// parseSmartctl is parse.js parseSmartctl.
func parseSmartctl(raw []byte) *smartRecord {
	var j smartctlJSON
	if err := json.Unmarshal(raw, &j); err != nil {
		return smartUnavailable("smartctl output was not JSON")
	}
	exit := 0
	if e := j.Smartctl.ExitStatus.num(); e != nil {
		exit = int(*e)
	}
	messages := []string{}
	for _, m := range j.Smartctl.Messages {
		if m.String != "" {
			messages = append(messages, m.String)
		}
	}
	out := &smartRecord{
		Available: true, DeviceType: j.Device.Type.str(), Model: j.ModelName.str(), Serial: j.SerialNumber.str(),
		Firmware: j.FirmwareVersion.str(), PowerCycles: j.PowerCycleCount.num(), ExitStatus: exit, Messages: messages,
	}
	if j.Temperature != nil {
		out.TemperatureC = j.Temperature.Current.num()
	}
	if j.PowerOnTime != nil {
		out.PowerOnHours = j.PowerOnTime.Hours.num()
	}
	// Bit 1 of the exit status: device open failed; bit 2: a command failed.
	if exit&0b10 != 0 && j.SmartStatus == nil {
		out.Available = false
		msg := "smartctl could not open the device"
		if len(messages) > 0 {
			msg = messages[0]
		}
		if smartPermissionRe.MatchString(msg) {
			msg = "permission_denied"
		}
		out.Error = strVal(msg)
		return out
	}
	if j.SmartStatus != nil && j.SmartStatus.Passed != nil {
		v := *j.SmartStatus.Passed
		out.Healthy = &v
	}
	if j.ATASmartAttributes != nil {
		for _, row := range j.ATASmartAttributes.Table {
			id := row.ID.num()
			if id == nil {
				continue
			}
			v := row.Raw.Value.num()
			switch int(*id) {
			case 5:
				out.ReallocatedSectors = v
			case 196:
				out.ReallocatedEvents = v
			case 197:
				out.PendingSectors = v
			case 198:
				out.OfflineUncorrectable = v
			case 187:
				out.ReportedUncorrectable = v
			case 199:
				out.UdmaCrcErrors = v
			}
		}
	}
	if nv := j.NVMeLog; nv != nil {
		out.PercentageUsed = nv.PercentageUsed.num()
		out.MediaErrors = nv.MediaErrors.num()
		out.AvailableSpare = nv.AvailableSpare.num()
		out.CriticalWarning = nv.CriticalWarning.num()
		if out.TemperatureC == nil {
			out.TemperatureC = nv.Temperature.num()
		}
		if out.PowerOnHours == nil {
			out.PowerOnHours = nv.PowerOnHours.num()
		}
		if out.Healthy == nil {
			cw := 0.0
			if out.CriticalWarning != nil {
				cw = *out.CriticalWarning
			}
			h := cw == 0
			out.Healthy = &h
		}
	}
	if out.Healthy == nil && j.SmartSupport != nil && j.SmartSupport.Available != nil && !*j.SmartSupport.Available {
		out.Available = false
		out.Error = strVal("SMART not supported")
	}
	return out
}

func smartFor(path string) *smartRecord {
	r, err := runStorage(smartctlBinary, storageTimeoutMedium, "-j", "-a", path)
	if err != nil {
		if errors.Is(err, errStorageNotInstalled) {
			return smartUnavailable("smartctl is not installed (apt-get install smartmontools)")
		}
		return smartUnavailable(err.Error())
	}
	if strings.HasPrefix(strings.TrimSpace(r.stdout), "{") {
		return parseSmartctl([]byte(r.stdout))
	}
	tail := stderrTail(r)
	if len(tail) > 200 {
		tail = tail[len(tail)-200:]
	}
	if tail == "" {
		tail = fmt.Sprintf("smartctl exit %d", r.status)
	}
	if smartPermissionRe.MatchString(tail) {
		tail = "permission_denied"
	}
	return smartUnavailable(tail)
}

/* -------------------------------- findmnt --------------------------------- */

var findmntBracketRe = regexp.MustCompile(`\[.*\]$`)
var wsRe = regexp.MustCompile(`\s+`)

// parseFindmnt is parse.js parseFindmnt: `TARGET SOURCE FSTYPE` rows, the
// btrfs `[/@]` subvolume suffix dropped from the source.
func parseFindmnt(text string) []storageMount {
	out := []storageMount{}
	for _, line := range strings.Split(text, "\n") {
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		parts := wsRe.Split(t, -1)
		if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
			continue
		}
		m := storageMount{Target: parts[0], Source: findmntBracketRe.ReplaceAllString(parts[1], "")}
		if len(parts) > 2 && parts[2] != "" {
			m.Fstype = strVal(parts[2])
		}
		out = append(out, m)
	}
	return out
}

func osMounts() ([]storageMount, []string) {
	out := []storageMount{}
	warnings := []string{}
	have := map[string]bool{}
	for _, target := range osMountTargets {
		r, err := runStorage(findmntBinary, storageTimeoutShort, "-rno", "TARGET,SOURCE,FSTYPE", "-T", target)
		if err != nil {
			warnings = append(warnings, "findmnt: "+err.Error())
			break
		}
		if r.status != 0 {
			continue
		}
		for _, m := range parseFindmnt(r.stdout) {
			if m.Target == target && !have[m.Target] {
				have[m.Target] = true
				out = append(out, m)
			}
		}
	}
	r, err := runStorage(swaponBinary, storageTimeoutShort, "--noheadings", "--raw", "--show=NAME")
	if err != nil {
		warnings = append(warnings, "swapon: "+err.Error())
	} else if r.status == 0 {
		for _, line := range strings.Split(r.stdout, "\n") {
			s := strings.TrimSpace(line)
			if strings.HasPrefix(s, "/dev/") {
				out = append(out, storageMount{Target: "swap", Source: s, Fstype: strVal("swap")})
			}
		}
	}
	return out, warnings
}

/* ------------------------------ zpool import ------------------------------ */

var (
	poolHeaderRe   = regexp.MustCompile(`^\s*pool:`)
	importSectRe   = regexp.MustCompile(`^\s*(pool|id|state|status|action|config):\s?(.*)$`)
	statusSectRe   = regexp.MustCompile(`^\s*(pool|state|status|action|see|scan|scrub|config|errors|checkpoint|remove):\s?(.*)$`)
	vdevGroupRe    = regexp.MustCompile(`^(mirror|raidz1|raidz2|raidz3|draid\d?|spare|replacing|indirect)-?\d*$`)
	vdevGroupNumRe = regexp.MustCompile(`-\d+$`)
	configHeaderRe = regexp.MustCompile(`^\s*NAME\s+STATE`)
)

// splitPoolChunks is the `\n(?=\s*pool:)` split: one chunk per pool.
func splitPoolChunks(text string) [][]string {
	var chunks [][]string
	for _, line := range strings.Split(text, "\n") {
		if poolHeaderRe.MatchString(line) {
			chunks = append(chunks, []string{line})
			continue
		}
		if len(chunks) > 0 {
			chunks[len(chunks)-1] = append(chunks[len(chunks)-1], line)
		}
	}
	return chunks
}

// parseZpoolImport is parse.js parseZpoolImport.
func parseZpoolImport(text string) []zpoolImportable {
	out := []zpoolImportable{}
	for _, lines := range splitPoolChunks(text) {
		pool := zpoolImportable{Devices: []string{}}
		inConfig := false
		for _, raw := range lines {
			if m := importSectRe.FindStringSubmatch(raw); m != nil {
				inConfig = m[1] == "config"
				v := strings.TrimSpace(m[2])
				switch m[1] {
				case "pool":
					pool.Name = v
				case "id":
					pool.ID = strVal(v)
				case "state":
					pool.State = strVal(v)
				case "status":
					pool.Status = strVal(v)
				case "action":
					pool.Action = strVal(v)
				}
				continue
			}
			if inConfig {
				t := strings.TrimSpace(raw)
				if t == "" {
					continue
				}
				parts := wsRe.Split(t, -1)
				if len(parts) >= 2 && parts[0] != pool.Name && !vdevGroupRe.MatchString(parts[0]) && parts[0] != "logs" && parts[0] != "cache" && parts[0] != "spares" {
					pool.Devices = append(pool.Devices, parts[0])
				}
			}
		}
		if pool.Name != "" {
			out = append(out, pool)
		}
	}
	return out
}

// zpoolImportScan runs the by-id scan. nil rows + warning means "could not
// run" (unprivileged, missing binary): the backend then scans itself.
func zpoolImportScan() ([]zpoolImportable, string) {
	r, err := runStorage(zpoolBinary, storageTimeoutLong, "import", "-d", "/dev/disk/by-id")
	if err != nil {
		if errors.Is(err, errStorageNotInstalled) {
			return nil, "zpool is not installed; import scan skipped"
		}
		return nil, "zpool import scan could not run: " + err.Error()
	}
	if r.status == 0 {
		return parseZpoolImport(r.stdout), ""
	}
	if strings.Contains(r.stdout+r.stderr, "no pools available") {
		return []zpoolImportable{}, ""
	}
	return nil, "zpool import scan failed (exit " + strconv.Itoa(r.status) + "): " + stderrTail(r)
}

/* ------------------------------- zpool list ------------------------------- */

// parseZpoolList is parse.js parseZpoolList.
func parseZpoolList(text string) []zpoolListRow {
	out := []zpoolListRow{}
	for _, c := range tsvRows(text) {
		row := zpoolListRow{
			Name: cell(c, 0), SizeBytes: numP(cell(c, 1)), AllocatedBytes: numP(cell(c, 2)), FreeBytes: numP(cell(c, 3)),
			FragmentationPct: numP(cell(c, 4)), CapacityPct: numP(cell(c, 5)),
			DedupRatio: numP(strings.TrimSuffix(cell(c, 7), "x")), GUID: strP(cell(c, 8)),
			Readonly: boolS(cell(c, 10)), Ashift: numP(cell(c, 11)),
		}
		if h := cell(c, 6); h != "" {
			row.Health = strVal(h)
		}
		if a := cell(c, 9); a != "" && a != "-" {
			row.Altroot = strVal(a)
		}
		out = append(out, row)
	}
	return out
}

func zpoolList() ([]zpoolListRow, *string) {
	r, err := runStorage(zpoolBinary, storageTimeoutMedium, "list", "-H", "-p", "-o", strings.Join(zpoolListColumns, ","))
	if err != nil {
		return []zpoolListRow{}, strVal(zpoolUnavailable(err))
	}
	if r.status != 0 {
		r2, err2 := runStorage(zpoolBinary, storageTimeoutMedium, "list", "-H", "-p", "-o", strings.Join(zpoolListColumns[:9], ","))
		if err2 != nil {
			return []zpoolListRow{}, strVal(zpoolUnavailable(err2))
		}
		if r2.status != 0 {
			tail := stderrTail(r2)
			if tail == "" {
				tail = stderrTail(r)
			}
			return []zpoolListRow{}, strVal(tail)
		}
		r = r2
	}
	return parseZpoolList(r.stdout), nil
}

func zpoolUnavailable(err error) string {
	if errors.Is(err, errStorageNotInstalled) {
		return "zpool is not installed (ZFS is not available on this host)"
	}
	return err.Error()
}

/* ------------------------------ zpool status ------------------------------ */

var (
	scanDoneRe      = regexp.MustCompile(`^(scrub|resilver)(?:ed| repaired)\s+(\S+)\s+in\s+(\S+(?: days? \S+)?)(?:\s+with\s+(\d+)\s+errors)?\s+on\s+(.+)$`)
	scanProgressRe  = regexp.MustCompile(`^(scrub|resilver) in progress since (.+)$`)
	scanCanceledRe  = regexp.MustCompile(`^(scrub|resilver) canceled on (.+)$`)
	scanPctRe       = regexp.MustCompile(`([\d.]+)% done`)
	scanToGoRe      = regexp.MustCompile(`,\s*([^,]+?) to go`)
	scanRepairedRe  = regexp.MustCompile(`(\S+) repaired`)
	noneRequestedRe = regexp.MustCompile(`^none requested`)
)

func joinTrimmed(lines []string, sep string) string {
	parts := make([]string, 0, len(lines))
	for _, l := range lines {
		if t := strings.TrimSpace(l); t != "" {
			parts = append(parts, t)
		}
	}
	return strings.Join(parts, sep)
}

// parseScan is parse.js parseScan.
func parseScan(lines []string) *zpoolScan {
	first := ""
	if len(lines) > 0 {
		first = strings.TrimSpace(lines[0])
	}
	all := strings.TrimSpace(strings.Join(lines, " "))
	if first == "" || noneRequestedRe.MatchString(first) {
		return &zpoolScan{State: "none", Text: strP(first)}
	}
	if m := scanDoneRe.FindStringSubmatch(first); m != nil {
		errs := 0.0
		if m[4] != "" {
			errs, _ = strconv.ParseFloat(m[4], 64)
		}
		when, _ := zpoolDateISO(m[5])
		return &zpoolScan{Function: strVal(m[1]), State: "finished", Repaired: strVal(m[2]), Duration: strVal(m[3]), Errors: numVal(errs), LastEnd: strVal(when), Percent: numVal(100), Text: strVal(all)}
	}
	if m := scanProgressRe.FindStringSubmatch(first); m != nil {
		rest := strings.Join(lines[1:], " ")
		s := &zpoolScan{Function: strVal(m[1]), State: "in_progress", Text: strVal(all)}
		since, _ := zpoolDateISO(m[2])
		s.Started = strVal(since)
		if p := scanPctRe.FindStringSubmatch(rest); p != nil {
			s.Percent = numP(p[1])
		}
		if tg := scanToGoRe.FindStringSubmatch(rest); tg != nil {
			s.ToGo = strVal(strings.TrimSpace(tg[1]))
		}
		if rp := scanRepairedRe.FindStringSubmatch(rest); rp != nil {
			s.Repaired = strVal(rp[1])
		}
		return s
	}
	if m := scanCanceledRe.FindStringSubmatch(first); m != nil {
		return &zpoolScan{Function: strVal(m[1]), State: "canceled", LastEnd: strVal(m[2]), Text: strVal(first)}
	}
	return &zpoolScan{State: "unknown", Text: strVal(all)}
}

type configRow struct {
	indent int
	name   string
	state  *string
	read   *float64
	write  *float64
	cksum  *float64
	note   *string
}

// parseConfigTree is parse.js parseConfigTree: pool → vdev group → leaf,
// indentation-driven; a leaf directly under the pool is a single-device
// vdev; logs/cache/spares/special/dedup headers switch the class.
func parseConfigTree(lines []string, poolName string) []zpoolVdevGroup {
	rows := []configRow{}
	for _, raw := range lines {
		line := strings.ReplaceAll(raw, "\t", "        ")
		if configHeaderRe.MatchString(line) {
			continue
		}
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		parts := wsRe.Split(trimmed, -1)
		row := configRow{indent: indent, name: parts[0]}
		if len(parts) > 1 {
			row.state = strVal(parts[1])
		}
		row.read = numP(cell(parts, 2))
		row.write = numP(cell(parts, 3))
		row.cksum = numP(cell(parts, 4))
		if len(parts) > 5 {
			row.note = strVal(strings.Join(parts[5:], " "))
		}
		rows = append(rows, row)
	}
	out := []zpoolVdevGroup{}
	cls := "data"
	base := -1
	var group *zpoolVdevGroup
	for _, r := range rows {
		if r.name == poolName && base < 0 {
			base = r.indent
			continue
		}
		switch r.name {
		case "logs", "cache", "spares", "special", "dedup":
			if r.state == nil {
				cls = r.name
				group = nil
				continue
			}
		}
		rel := 0
		if base >= 0 {
			rel = r.indent - base
		}
		leaf := zpoolVdevLeaf{Name: r.name, State: r.state, ReadErrors: r.read, WriteErrors: r.write, CksumErrors: r.cksum, Note: r.note, Class: cls}
		if strings.HasPrefix(r.name, "/") {
			leaf.Path = strVal(r.name)
		}
		if vdevGroupRe.MatchString(r.name) {
			out = append(out, zpoolVdevGroup{Name: r.name, Type: vdevGroupNumRe.ReplaceAllString(r.name, ""), State: r.state, ReadErrors: r.read, WriteErrors: r.write, CksumErrors: r.cksum, Class: cls, Devices: []zpoolVdevLeaf{}, indent: rel})
			group = &out[len(out)-1]
			continue
		}
		if group != nil && rel > group.indent {
			group.Devices = append(group.Devices, leaf)
			continue
		}
		group = nil
		out = append(out, zpoolVdevGroup{Name: r.name, Type: "single", State: r.state, ReadErrors: r.read, WriteErrors: r.write, CksumErrors: r.cksum, Class: cls, Devices: []zpoolVdevLeaf{leaf}, indent: rel})
	}
	return out
}

// parseZpoolStatus is parse.js parseZpoolStatus (`zpool status -P -p -v`).
func parseZpoolStatus(text string) []zpoolPool {
	pools := []zpoolPool{}
	for _, lines := range splitPoolChunks(text) {
		sec := map[string][]string{}
		section := ""
		for _, raw := range lines {
			if m := statusSectRe.FindStringSubmatch(raw); m != nil {
				section = m[1]
				sec[section] = []string{m[2]}
				continue
			}
			if section != "" {
				sec[section] = append(sec[section], raw)
			}
		}
		pool := zpoolPool{Vdevs: []zpoolVdevGroup{}}
		if v, ok := sec["pool"]; ok && len(v) > 0 {
			pool.Name = strings.TrimSpace(v[0])
		}
		if v, ok := sec["state"]; ok && len(v) > 0 {
			pool.State = strP(v[0])
		}
		if v, ok := sec["status"]; ok {
			pool.Status = strVal(joinTrimmed(v, " "))
		}
		if v, ok := sec["action"]; ok {
			pool.Action = strVal(joinTrimmed(v, " "))
		}
		if v, ok := sec["see"]; ok {
			pool.See = strVal(joinTrimmed(v, " "))
		}
		if v, ok := sec["checkpoint"]; ok {
			pool.Checkpoint = strVal(joinTrimmed(v, " "))
		}
		scanLines := sec["scan"]
		if scanLines == nil {
			scanLines = sec["scrub"]
		}
		pool.Scan = parseScan(scanLines)
		if v, ok := sec["errors"]; ok {
			pool.Errors = strVal(joinTrimmed(v, " "))
			pool.ErrorCount = errorCountFromText(*pool.Errors)
		}
		cfg := []string{}
		for _, l := range sec["config"] {
			if strings.TrimSpace(l) != "" {
				cfg = append(cfg, l)
			}
		}
		pool.ConfigText = strVal(strings.Join(cfg, "\n"))
		pool.Vdevs = parseConfigTree(cfg, pool.Name)
		pools = append(pools, pool)
	}
	return pools
}

// --- zpool status -j (OpenZFS ≥ 2.3) ---

// orderedVdevs keeps a JSON object's key order (JS Object.values order), so
// the vdev tree comes out in the order zpool printed it.
type orderedVdevs struct {
	items []zpoolJSONVdev
}

func (o *orderedVdevs) UnmarshalJSON(b []byte) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil // null or a non-object: no vdevs
	}
	for dec.More() {
		if _, err := dec.Token(); err != nil {
			return err
		}
		var v zpoolJSONVdev
		if err := dec.Decode(&v); err != nil {
			return err
		}
		o.items = append(o.items, v)
	}
	return nil
}

type orderedPools struct {
	items []zpoolJSONPool
}

func (o *orderedPools) UnmarshalJSON(b []byte) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil
	}
	for dec.More() {
		if _, err := dec.Token(); err != nil {
			return err
		}
		var p zpoolJSONPool
		if err := dec.Decode(&p); err != nil {
			return err
		}
		o.items = append(o.items, p)
	}
	return nil
}

type zpoolJSONVdev struct {
	Name           jsonScalar   `json:"name"`
	VdevType       jsonScalar   `json:"vdev_type"`
	Path           jsonScalar   `json:"path"`
	State          jsonScalar   `json:"state"`
	Class          jsonScalar   `json:"class"`
	ReadErrors     jsonScalar   `json:"read_errors"`
	WriteErrors    jsonScalar   `json:"write_errors"`
	ChecksumErrors jsonScalar   `json:"checksum_errors"`
	Vdevs          orderedVdevs `json:"vdevs"`
}

type zpoolJSONPool struct {
	Name       jsonScalar `json:"name"`
	State      jsonScalar `json:"state"`
	Status     jsonScalar `json:"status"`
	Action     jsonScalar `json:"action"`
	ErrorCount jsonScalar `json:"error_count"`
	ScanStats  *struct {
		Function  jsonScalar `json:"function"`
		State     jsonScalar `json:"state"`
		StartTime jsonScalar `json:"start_time"`
		EndTime   jsonScalar `json:"end_time"`
		Errors    jsonScalar `json:"errors"`
		PctDone   jsonScalar `json:"pct_done"`
		Repaired  jsonScalar `json:"repaired"`
	} `json:"scan_stats"`
	Vdevs orderedVdevs `json:"vdevs"`
}

// isoFromEpochOrText is parse.js isoFromEpochOrText: epoch seconds or a
// zpool date, else the raw text. Empty / zero → null.
func isoFromEpochOrText(v jsonScalar) *string {
	s := strings.TrimSpace(v.text())
	if s == "" || s == "0" {
		return nil
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		if f > 1e9 {
			return strVal(epochISO(f))
		}
		return strVal(s)
	}
	iso, _ := zpoolDateISO(s)
	return strVal(iso)
}

func jsonLeaf(d *zpoolJSONVdev, cls string) zpoolVdevLeaf {
	name := d.Name.text()
	leaf := zpoolVdevLeaf{Name: name, Path: d.Path.str(), State: d.State.str(), ReadErrors: d.ReadErrors.num(), WriteErrors: d.WriteErrors.num(), CksumErrors: d.ChecksumErrors.num(), Class: cls}
	if leaf.Path == nil && strings.HasPrefix(name, "/") {
		leaf.Path = strVal(name)
	}
	return leaf
}

// errorCountFromText is parse.js errorCountFromText: the numeric count behind
// zpool status's "errors:" line, so both forms answer the same question.
func errorCountFromText(errors string) *float64 {
	if errors == "" {
		return nil
	}
	if strings.Contains(strings.ToLower(errors), "no known data errors") {
		return f64Val(0)
	}
	m := dataErrorsRe.FindStringSubmatch(errors)
	if m == nil {
		return nil
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return nil
	}
	return f64Val(n)
}

var dataErrorsRe = regexp.MustCompile(`(?i)(\d+)\s+data errors?`)

// parseZpoolStatusJSON is parse.js parseZpoolStatusJson.
func parseZpoolStatusJSON(raw []byte) ([]zpoolPool, error) {
	var j struct {
		Pools orderedPools `json:"pools"`
	}
	if err := json.Unmarshal(raw, &j); err != nil {
		return nil, err
	}
	pools := []zpoolPool{}
	for i := range j.Pools.items {
		p := &j.Pools.items[i]
		name := p.Name.text()
		scan := &zpoolScan{State: "none"}
		if ss := p.ScanStats; ss != nil {
			if f := ss.Function.str(); f != nil {
				scan.Function = strVal(strings.ToLower(*f))
			}
			switch ss.State.text() {
			case "FINISHED":
				scan.State = "finished"
			case "SCANNING":
				scan.State = "in_progress"
			case "CANCELED":
				scan.State = "canceled"
			}
			scan.LastEnd = isoFromEpochOrText(ss.EndTime)
			scan.Started = isoFromEpochOrText(ss.StartTime)
			scan.Errors = ss.Errors.num()
			scan.Percent = ss.PctDone.num()
			scan.Repaired = ss.Repaired.str()
		}
		top := p.Vdevs.items
		for k := range p.Vdevs.items {
			if p.Vdevs.items[k].Name.text() == name && len(p.Vdevs.items[k].Vdevs.items) > 0 {
				top = p.Vdevs.items[k].Vdevs.items
				break
			}
		}
		vdevs := []zpoolVdevGroup{}
		for k := range top {
			v := &top[k]
			cls := "data"
			leafCls := "data"
			if c := v.Class.str(); c != nil {
				leafCls = *c
				if *c != "normal" {
					cls = *c
				}
			}
			g := zpoolVdevGroup{Name: v.Name.text(), State: v.State.str(), ReadErrors: v.ReadErrors.num(), WriteErrors: v.WriteErrors.num(), CksumErrors: v.ChecksumErrors.num(), Class: cls, Devices: []zpoolVdevLeaf{}}
			if len(v.Vdevs.items) > 0 {
				t := v.Name.text()
				if vt := v.VdevType.str(); vt != nil {
					t = *vt
				}
				g.Type = vdevGroupNumRe.ReplaceAllString(t, "")
				for d := range v.Vdevs.items {
					g.Devices = append(g.Devices, jsonLeaf(&v.Vdevs.items[d], leafCls))
				}
			} else {
				g.Type = "single"
				g.Devices = append(g.Devices, jsonLeaf(v, leafCls))
			}
			vdevs = append(vdevs, g)
		}
		pool := zpoolPool{Name: name, State: p.State.str(), Status: p.Status.str(), Action: p.Action.str(), Scan: scan, Vdevs: vdevs}
		// error_count: 0 is the healthy case. Saying "0 data errors" here made
		// every consumer read a healthy pool as faulted (it is a non-empty
		// string and does not match /no known data errors/), so word it the
		// way the text form does and carry the number alongside it.
		if ec := p.ErrorCount.num(); ec != nil {
			pool.ErrorCount = ec
			if *ec > 0 {
				pool.Errors = strVal(strconv.FormatFloat(*ec, 'f', -1, 64) + " data errors")
			} else {
				pool.Errors = strVal("No known data errors")
			}
		}
		pools = append(pools, pool)
	}
	return pools, nil
}

func zpoolStatus() ([]zpoolPool, error) {
	j, err := runStorage(zpoolBinary, storageTimeoutMedium, "status", "-j", "--json-int")
	if err != nil {
		return []zpoolPool{}, err
	}
	if j.status == 0 && strings.HasPrefix(strings.TrimSpace(j.stdout), "{") {
		if pools, perr := parseZpoolStatusJSON([]byte(j.stdout)); perr == nil {
			return pools, nil
		}
	}
	r, err := runStorage(zpoolBinary, storageTimeoutMedium, "status", "-P", "-p", "-v")
	if err != nil {
		return []zpoolPool{}, err
	}
	if r.status != 0 {
		return []zpoolPool{}, nil
	}
	return parseZpoolStatus(r.stdout), nil
}

/* -------------------------------- zfs list -------------------------------- */

func dashNull(s string) *string {
	if s == "" || s == "-" {
		return nil
	}
	return strVal(s)
}

func emptyNull(s string) *string {
	if s == "" {
		return nil
	}
	return strVal(s)
}

// parseZfsList is parse.js parseZfsList.
func parseZfsList(text string) []zfsDataset {
	out := []zfsDataset{}
	for _, c := range tsvRows(text) {
		name := cell(c, 0)
		typ := cell(c, 1)
		if typ == "" {
			typ = "filesystem"
		}
		d := zfsDataset{
			Name: name, Type: typ, Pool: strings.SplitN(name, "/", 2)[0],
			UsedBytes: numP(cell(c, 2)), AvailableBytes: numP(cell(c, 3)), ReferencedBytes: numP(cell(c, 4)),
			QuotaBytes: numOrNull(cell(c, 5)), RefquotaBytes: numOrNull(cell(c, 6)), ReservationBytes: numOrNull(cell(c, 7)),
			Compression: emptyNull(cell(c, 8)), CompressRatio: numP(strings.TrimSuffix(cell(c, 9), "x")),
			Keystatus: dashNull(cell(c, 11)), Mountpoint: emptyNull(cell(c, 13)), Mounted: boolS(cell(c, 14)),
			Canmount: emptyNull(cell(c, 15)), RecordsizeBytes: numP(cell(c, 16)), Atime: emptyNull(cell(c, 17)), Xattr: emptyNull(cell(c, 18)),
			Origin: dashNull(cell(c, 19)), Creation: epochISOFromCell(cell(c, 20)), Readonly: boolS(cell(c, 21)), VolsizeBytes: numOrNull(cell(c, 22)),
		}
		if e := cell(c, 10); e != "" && e != "off" {
			d.Encryption = strVal(e)
		}
		if k := cell(c, 12); k != "" && k != "-" && k != "none" {
			d.Keylocation = strVal(k)
		}
		out = append(out, d)
	}
	return out
}

// classifySnapshotName is parse.js classifySnapshotName.
func classifySnapshotName(name string) string {
	switch {
	case strings.HasPrefix(name, "autosnap_"):
		return "sanoid"
	case strings.HasPrefix(name, "syncoid_"):
		return "syncoid"
	case strings.HasPrefix(name, "snapshot-"):
		return "incus"
	case strings.HasPrefix(name, "pp-"):
		return "proxypilot"
	}
	return "manual"
}

// parseZfsSnapshots is parse.js parseZfsSnapshots.
func parseZfsSnapshots(text string) []zfsSnapshot {
	out := []zfsSnapshot{}
	for _, c := range tsvRows(text) {
		name := cell(c, 0)
		dataset, snap := name, ""
		if i := strings.Index(name, "@"); i >= 0 {
			dataset, snap = name[:i], name[i+1:]
		}
		s := zfsSnapshot{
			Name: name, Dataset: dataset, Snapshot: emptyNull(snap), Pool: strings.SplitN(dataset, "/", 2)[0],
			CreatedAt: epochISOFromCell(cell(c, 1)), UsedBytes: numP(cell(c, 2)), ReferencedBytes: numP(cell(c, 3)),
			Clones: []string{}, CreateTxg: numP(cell(c, 7)), Kind: classifySnapshotName(snap),
		}
		if cl := cell(c, 4); cl != "" && cl != "-" {
			s.Clones = strings.Split(cl, ",")
		}
		if h := numP(cell(c, 6)); h != nil {
			s.Holds = *h
		}
		out = append(out, s)
	}
	return out
}

func zfsUnavailable(err error) string {
	if errors.Is(err, errStorageNotInstalled) {
		return "zfs is not installed (ZFS is not available on this host)"
	}
	return err.Error()
}

func zfsList() ([]zfsDataset, *string) {
	r, err := runStorage(zfsBinary, 60*time.Second, "list", "-H", "-p", "-t", "filesystem,volume", "-o", strings.Join(zfsListColumns, ","))
	if err != nil {
		return []zfsDataset{}, strVal(zfsUnavailable(err))
	}
	if r.status != 0 {
		return []zfsDataset{}, strVal(stderrTail(r))
	}
	return parseZfsList(r.stdout), nil
}

func zfsSnapshots() ([]zfsSnapshot, *string) {
	r, err := runStorage(zfsBinary, storageTimeoutLong, "list", "-H", "-p", "-t", "snapshot", "-o", strings.Join(zfsSnapshotColumns, ","), "-s", "creation")
	if err != nil {
		return []zfsSnapshot{}, strVal(zfsUnavailable(err))
	}
	if r.status != 0 {
		return []zfsSnapshot{}, strVal(stderrTail(r))
	}
	return parseZfsSnapshots(r.stdout), nil
}

/* -------------------------------- handlers -------------------------------- */

type storageListDisksParams struct {
	Smart       *bool `json:"smart"`
	IncludeLoop bool  `json:"include_loop"`
}

// StorageListDisks is the storage.list_disks RPC handler.
//
// Params: {"smart": bool} (default true), plus the optional "include_loop"
// (default false: the PROXYPILOT_STORAGE_INCLUDE_LOOP knob host.js applies
// to its own lsblk parse). Result: parse.js-shaped devices
// with by_id and smart attached, the OS mounts, the importable-pool scan
// (null when it could not run) and warnings. lsblk failing is the only
// envelope error: without it there is no inventory to return.
func StorageListDisks(params json.RawMessage) (any, *Error) {
	p := storageListDisksParams{}
	if len(bytes.TrimSpace(params)) > 0 && !bytes.Equal(bytes.TrimSpace(params), []byte("null")) {
		if err := decodeParams(params, &p); err != nil {
			return nil, &Error{Code: "invalid_params", Message: "storage.list_disks params must be {smart?:bool, include_loop?:bool}: " + err.Error()}
		}
	}
	wantSmart := p.Smart == nil || *p.Smart

	devices, err := lsblkDevices(p.IncludeLoop)
	if err != nil {
		if errors.Is(err, errStorageNotInstalled) {
			return nil, &Error{Code: "lsblk_unavailable", Message: "lsblk is not installed on the host"}
		}
		return nil, &Error{Code: "lsblk_failed", Message: err.Error()}
	}
	warnings := []string{}

	byID := byIDMap()
	for i := range devices {
		d := &devices[i]
		if links, ok := byID[d.Path]; ok {
			d.ByID = links
		}
		for j := range d.Partitions {
			if links, ok := byID[d.Partitions[j].Path]; ok {
				d.Partitions[j].ByID = links
			}
		}
		if wantSmart {
			d.Smart = smartFor(d.Path)
		} else {
			d.Smart = smartUnavailable("not collected")
		}
	}

	mounts, mountWarnings := osMounts()
	warnings = append(warnings, mountWarnings...)

	importable, warn := zpoolImportScan()
	if warn != "" {
		warnings = append(warnings, warn)
	}

	return storageListDisksResult{Devices: devices, Mounts: mounts, Importable: importable, Warnings: warnings}, nil
}

// StorageZpoolStatus is the storage.zpool_status RPC handler: the parsed
// `zpool list` rows and the `zpool status` pool tree. `error` carries the
// list failure (zpool missing, exec error); status problems degrade to an
// empty tree, as in host.js.
func StorageZpoolStatus(_ json.RawMessage) (any, *Error) {
	list, listErr := zpoolList()
	status, err := zpoolStatus()
	if listErr == nil && err != nil {
		listErr = strVal(zpoolUnavailable(err))
	}
	return storageZpoolStatusResult{List: list, Status: status, Error: listErr}, nil
}

// StorageZfsList is the storage.zfs_list RPC handler: datasets (filesystems
// and volumes) and snapshots, oldest first.
func StorageZfsList(_ json.RawMessage) (any, *Error) {
	datasets, dErr := zfsList()
	snapshots, sErr := zfsSnapshots()
	e := dErr
	if e == nil {
		e = sErr
	}
	return storageZfsListResult{Datasets: datasets, Snapshots: snapshots, Error: e}, nil
}
