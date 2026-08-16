//go:build windows

package omprpc

import (
	"fmt"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

type processTree struct{ job windows.Handle }

func validatePlatformConfig(config Config) error {
	if config.User != "" || config.Group != "" || config.ExtraGroups != nil {
		return fmt.Errorf("process user/group credentials are not supported on Windows")
	}
	return nil
}

func configureProcess(cmd *exec.Cmd, config Config) error {
	if err := validatePlatformConfig(config); err != nil {
		return err
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP, HideWindow: true}
	return nil
}

func attachProcessTree(cmd *exec.Cmd) (*processTree, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("create omp job object: %w", err)
	}
	information := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	information.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&information)), uint32(unsafe.Sizeof(information))); err != nil {
		windows.CloseHandle(job)
		return nil, fmt.Errorf("configure omp job object: %w", err)
	}
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		windows.CloseHandle(job)
		return nil, fmt.Errorf("open omp process for job assignment: %w", err)
	}
	err = windows.AssignProcessToJobObject(job, process)
	windows.CloseHandle(process)
	if err != nil {
		windows.CloseHandle(job)
		return nil, fmt.Errorf("assign omp process to job object: %w", err)
	}
	return &processTree{job: job}, nil
}

func terminateProcessTree(cmd *exec.Cmd, tree *processTree) error {
	if tree == nil || tree.job == 0 {
		if cmd.Process == nil {
			return nil
		}
		return cmd.Process.Kill()
	}
	err := windows.TerminateJobObject(tree.job, 1)
	closeErr := windows.CloseHandle(tree.job)
	tree.job = 0
	if err != nil {
		return fmt.Errorf("terminate omp job object: %w", err)
	}
	if closeErr != nil {
		return fmt.Errorf("close omp job object: %w", closeErr)
	}
	return nil
}
