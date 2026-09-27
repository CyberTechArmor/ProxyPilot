package methods

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const incusUpgradeBackupRoot = "/var/backups/proxypilot/incus"

var incusUpgradeBackupName = regexp.MustCompile(`^pre-upgrade-[0-9]{8}T[0-9]{6}Z-[1-9][0-9]*$`)
var incusUpgradeBackupFiles = map[string]bool{
	"incus.tar": true, "local.sql": true, "global.sql": true,
	"SHA256SUMS": true, "subuid": true, "subgid": true,
}

type incusUpgradeBackup struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Fingerprint string `json:"fingerprint"`
	Bytes       int64  `json:"bytes"`
	Files       []string `json:"files"`
}

func inspectIncusUpgradeBackup(root, name string) (incusUpgradeBackup, error) {
	if !incusUpgradeBackupName.MatchString(name) {
		return incusUpgradeBackup{}, fmt.Errorf("invalid Incus upgrade backup name")
	}
	path := filepath.Join(root, name)
	info, err := os.Lstat(path)
	if err != nil { return incusUpgradeBackup{}, err }
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return incusUpgradeBackup{}, fmt.Errorf("backup is not a real directory")
	}
	entries, err := os.ReadDir(path)
	if err != nil { return incusUpgradeBackup{}, err }
	seen := map[string]bool{}
	var total int64
	var files []string
	h := sha256.New()
	fmt.Fprintf(h, "%s\n", name)
	for _, entry := range entries {
		file := entry.Name()
		if !incusUpgradeBackupFiles[file] { return incusUpgradeBackup{}, fmt.Errorf("unexpected backup entry %q", file) }
		fi, err := os.Lstat(filepath.Join(path, file))
		if err != nil { return incusUpgradeBackup{}, err }
		if !fi.Mode().IsRegular() { return incusUpgradeBackup{}, fmt.Errorf("backup entry %q is not a regular file", file) }
		seen[file] = true
		total += fi.Size()
		files = append(files, file)
		fmt.Fprintf(h, "%s:%d:%d\n", file, fi.Size(), fi.ModTime().UnixNano())
		if file == "SHA256SUMS" {
			if fi.Size() > 4096 { return incusUpgradeBackup{}, fmt.Errorf("SHA256SUMS is unexpectedly large") }
			body, err := os.ReadFile(filepath.Join(path, file))
			if err != nil { return incusUpgradeBackup{}, err }
			h.Write(body)
		}
	}
	for _, required := range []string{"incus.tar", "local.sql", "global.sql", "SHA256SUMS"} {
		if !seen[required] { return incusUpgradeBackup{}, fmt.Errorf("backup lacks %s", required) }
	}
	sort.Strings(files)
	return incusUpgradeBackup{Name: name, Path: path, Fingerprint: hex.EncodeToString(h.Sum(nil)), Bytes: total, Files: files}, nil
}

func IncusUpgradeBackupsList(_ json.RawMessage) (any, *Error) {
	entries, err := os.ReadDir(incusUpgradeBackupRoot)
	if os.IsNotExist(err) { return map[string]any{"backups": []incusUpgradeBackup{}}, nil }
	if err != nil { return nil, &Error{Code: "backup_inventory_failed", Message: err.Error()} }
	backups := []incusUpgradeBackup{}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "pre-upgrade-") { continue }
		backup, err := inspectIncusUpgradeBackup(incusUpgradeBackupRoot, entry.Name())
		if err != nil { return nil, &Error{Code: "backup_inventory_failed", Message: entry.Name() + ": " + err.Error()} }
		backups = append(backups, backup)
	}
	return map[string]any{"backups": backups}, nil
}

type incusUpgradeBackupRemoveParams struct {
	Name string `json:"name"`
	ExpectedFingerprint string `json:"expected_fingerprint"`
}

func IncusUpgradeBackupRemove(params json.RawMessage) (any, *Error) {
	var p incusUpgradeBackupRemoveParams
	if err := decodeParams(params, &p); err != nil {
		return nil, &Error{Code: "invalid_params", Message: err.Error()}
	}
	if !incusUpgradeBackupName.MatchString(p.Name) || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(p.ExpectedFingerprint) {
		return nil, &Error{Code: "invalid_params", Message: "name and expected_fingerprint must match a reviewed upgrade backup"}
	}
	state, err := readJSONObject(filepath.Join(updateStateDir, "state.json"))
	if err != nil { return nil, &Error{Code: "update_state_unreadable", Message: err.Error()} }
	if updateRunLive(state, updateNow()) || updateRequestPending() {
		return nil, &Error{Code: "update_in_progress", Message: "an update is running or pending; no backup was removed"}
	}
	backup, err := inspectIncusUpgradeBackup(incusUpgradeBackupRoot, p.Name)
	if err != nil { return nil, &Error{Code: "backup_unavailable", Message: err.Error()} }
	if backup.Fingerprint != p.ExpectedFingerprint {
		return nil, &Error{Code: "backup_changed", Message: "backup changed since review; no file was removed"}
	}
	// Files are fixed, flat and independently verified as regular files. Avoid
	// recursive removal and never cross a symlink into another host directory.
	for _, file := range backup.Files {
		if err := os.Remove(filepath.Join(backup.Path, file)); err != nil {
			return nil, &Error{Code: "backup_remove_failed", Message: err.Error()}
		}
	}
	if err := os.Remove(backup.Path); err != nil { return nil, &Error{Code: "backup_remove_failed", Message: err.Error()} }
	return map[string]any{"removed": true, "name": backup.Name, "bytes": backup.Bytes, "files": backup.Files}, nil
}
