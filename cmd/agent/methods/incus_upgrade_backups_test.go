package methods

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInspectIncusUpgradeBackup(t *testing.T) {
	root := t.TempDir()
	name := "pre-upgrade-20260926T131704Z-1234"
	path := filepath.Join(root, name)
	if err := os.Mkdir(path, 0700); err != nil { t.Fatal(err) }
	for _, file := range []string{"incus.tar", "local.sql", "global.sql", "SHA256SUMS"} {
		if err := os.WriteFile(filepath.Join(path, file), []byte(file), 0600); err != nil { t.Fatal(err) }
	}
	backup, err := inspectIncusUpgradeBackup(root, name)
	if err != nil { t.Fatal(err) }
	if backup.Name != name || len(backup.Fingerprint) != 64 || len(backup.Files) != 4 {
		t.Fatalf("unexpected backup inventory: %+v", backup)
	}
	if err := os.WriteFile(filepath.Join(path, "incus.tar"), []byte("changed"), 0600); err != nil { t.Fatal(err) }
	changed, err := inspectIncusUpgradeBackup(root, name)
	if err != nil { t.Fatal(err) }
	if changed.Fingerprint == backup.Fingerprint { t.Fatal("changed backup kept the same fingerprint") }
	if err := os.Symlink(filepath.Join(root, "elsewhere"), filepath.Join(path, "unexpected")); err != nil { t.Skipf("symlinks unavailable: %v", err) }
	if _, err := inspectIncusUpgradeBackup(root, name); err == nil { t.Fatal("unexpected entry was accepted") }
	if _, err := inspectIncusUpgradeBackup(root, "../outside"); err == nil { t.Fatal("path traversal was accepted") }
}
