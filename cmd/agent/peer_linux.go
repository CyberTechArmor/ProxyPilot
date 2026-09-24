//go:build linux

package main

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"syscall"
)

// Kernel credentials authenticate the local process, not the dashboard user.
// Root's unit configuration must explicitly allow any non-root backend UID.
func socketPeer(conn net.Conn) (peerIdentity, error) {
	unix, ok := conn.(*net.UnixConn)
	if !ok {
		return peerIdentity{}, fmt.Errorf("Unix peer required")
	}
	raw, err := unix.SyscallConn()
	if err != nil {
		return peerIdentity{}, err
	}
	var cred *syscall.Ucred
	var credentialErr error
	if err = raw.Control(func(fd uintptr) {
		cred, credentialErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return peerIdentity{}, err
	}
	if credentialErr != nil {
		return peerIdentity{}, credentialErr
	}
	return peerIdentity{UID: cred.Uid, PID: cred.Pid}, nil
}

func parseUIDs(value string) (map[uint32]bool, error) {
	allowed := make(map[uint32]bool)
	for _, part := range strings.Split(value, ",") {
		if part == "" || strings.Trim(part, "0123456789") != "" {
			return nil, fmt.Errorf("client-uids requires decimal UIDs")
		}
		uid, err := strconv.ParseUint(part, 10, 32)
		if err != nil {
			return nil, err
		}
		allowed[uint32(uid)] = true
	}
	return allowed, nil
}
