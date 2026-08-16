//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package omprpc

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"syscall"
	"time"
)

type processTree struct{ pgid int }

func parseUint32(kind, value string) (uint32, error) {
	parsed, err := strconv.ParseUint(value, 10, 32)
	if err != nil {
		return 0, fmt.Errorf("invalid %s id %q: %w", kind, value, err)
	}
	return uint32(parsed), nil
}

func resolveUser(spec string) (uint32, uint32, error) {
	if parsed, err := strconv.ParseUint(spec, 10, 32); err == nil {
		return uint32(parsed), uint32(os.Getegid()), nil
	}
	account, err := user.Lookup(spec)
	if err != nil {
		return 0, 0, fmt.Errorf("resolve user %q: %w", spec, err)
	}
	uid, err := parseUint32("user", account.Uid)
	if err != nil {
		return 0, 0, err
	}
	gid, err := parseUint32("group", account.Gid)
	if err != nil {
		return 0, 0, err
	}
	return uid, gid, nil
}

func resolveGroup(spec string) (uint32, error) {
	if parsed, err := strconv.ParseUint(spec, 10, 32); err == nil {
		return uint32(parsed), nil
	}
	group, err := user.LookupGroup(spec)
	if err != nil {
		return 0, fmt.Errorf("resolve group %q: %w", spec, err)
	}
	return parseUint32("group", group.Gid)
}

func resolveCredential(config Config) (*syscall.Credential, error) {
	if config.User == "" && config.Group == "" && config.ExtraGroups == nil {
		return nil, nil
	}
	credential := &syscall.Credential{Uid: uint32(os.Geteuid()), Gid: uint32(os.Getegid())}
	if config.User != "" {
		uid, gid, err := resolveUser(config.User)
		if err != nil {
			return nil, err
		}
		credential.Uid, credential.Gid = uid, gid
	}
	if config.Group != "" {
		gid, err := resolveGroup(config.Group)
		if err != nil {
			return nil, err
		}
		credential.Gid = gid
	}
	if config.ExtraGroups != nil {
		credential.Groups = make([]uint32, 0, len(config.ExtraGroups))
		for _, group := range config.ExtraGroups {
			gid, err := resolveGroup(group)
			if err != nil {
				return nil, err
			}
			credential.Groups = append(credential.Groups, gid)
		}
	}
	return credential, nil
}

func validatePlatformConfig(config Config) error { _, err := resolveCredential(config); return err }

func configureProcess(cmd *exec.Cmd, config Config) error {
	credential, err := resolveCredential(config)
	if err != nil {
		return err
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Credential: credential}
	return nil
}

func attachProcessTree(cmd *exec.Cmd) (*processTree, error) {
	pgid, err := syscall.Getpgid(cmd.Process.Pid)
	if err != nil {
		return nil, fmt.Errorf("capture omp process group: %w", err)
	}
	return &processTree{pgid: pgid}, nil
}

func terminateProcessTree(cmd *exec.Cmd, tree *processTree) error {
	if cmd.Process == nil {
		return nil
	}
	pgid := cmd.Process.Pid
	if tree != nil && tree.pgid > 0 {
		pgid = tree.pgid
	}
	if err := syscall.Kill(-pgid, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	time.Sleep(250 * time.Millisecond)
	if err := syscall.Kill(-pgid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
}
