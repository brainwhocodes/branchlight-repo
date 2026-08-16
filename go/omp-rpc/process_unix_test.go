//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package omprpc

import (
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"testing"
)

func TestUnixCredentialResolutionByIDAndName(t *testing.T) {
	current, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	for _, config := range []Config{{User: current.Username, Group: current.Gid}, {User: strconv.Itoa(os.Geteuid()), Group: strconv.Itoa(os.Getegid()), ExtraGroups: []string{current.Gid}}} {
		if err = validatePlatformConfig(config); err != nil {
			t.Fatal(err)
		}
		command := exec.Command("ignored")
		if err = configureProcess(command, config); err != nil {
			t.Fatal(err)
		}
		if command.SysProcAttr == nil || command.SysProcAttr.Credential == nil {
			t.Fatal("credential was not attached")
		}
		if command.SysProcAttr.Credential.Uid != uint32(os.Geteuid()) || command.SysProcAttr.Credential.Gid != uint32(os.Getegid()) {
			t.Fatalf("unexpected credential: %#v", command.SysProcAttr.Credential)
		}
	}
}

func TestNewRejectsInvalidIdentityAndBounds(t *testing.T) {
	if _, err := New(Config{User: "omp-user-that-does-not-exist"}); err == nil {
		t.Fatal("unknown user was accepted")
	}
	if _, err := New(Config{MaxEventHistory: -1}); err == nil {
		t.Fatal("negative event history was accepted")
	}
	if _, err := New(Config{UnboundedEventHistory: true, MaxEventHistory: 10}); err == nil {
		t.Fatal("conflicting history options were accepted")
	}
	client, err := New(Config{UnboundedEventHistory: true, UnboundedStderrHistory: true})
	if err != nil {
		t.Fatal(err)
	}
	if client.cfg.MaxEventHistory != -1 || client.cfg.MaxStderrChunks != -1 {
		t.Fatalf("unbounded histories not normalized: %#v", client.cfg)
	}
}
