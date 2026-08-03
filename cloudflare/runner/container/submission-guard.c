#define _GNU_SOURCE

#include <errno.h>
#include <limits.h>
#include <linux/capability.h>
#include <seccomp.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

enum {
  SUBMISSION_UID = 65532,
  SUBMISSION_GID = 65532,
  GUARD_FAILURE_EXIT = 126,
};

static int refuse_execution(void) {
  fputs("submission guard refused execution\n", stderr);
  return GUARD_FAILURE_EXIT;
}

static bool has_no_capabilities(void) {
  struct __user_cap_header_struct header = {
      .version = _LINUX_CAPABILITY_VERSION_3,
      .pid = 0,
  };
  struct __user_cap_data_struct capabilities[_LINUX_CAPABILITY_U32S_3] = {0};

  if (syscall(SYS_capget, &header, capabilities) != 0) return false;
  for (size_t index = 0; index < _LINUX_CAPABILITY_U32S_3; index += 1) {
    if (capabilities[index].effective != 0 ||
        capabilities[index].permitted != 0 ||
        capabilities[index].inheritable != 0) {
      return false;
    }
  }

  for (int capability = 0; capability <= CAP_LAST_CAP; capability += 1) {
    const int bounded = prctl(PR_CAPBSET_READ, capability, 0, 0, 0);
    if (bounded != 0) return false;
  }
  return true;
}

static bool has_submission_identity(void) {
  uid_t real_uid = 0;
  uid_t effective_uid = 0;
  uid_t saved_uid = 0;
  gid_t real_gid = 0;
  gid_t effective_gid = 0;
  gid_t saved_gid = 0;

  if (getresuid(&real_uid, &effective_uid, &saved_uid) != 0 ||
      getresgid(&real_gid, &effective_gid, &saved_gid) != 0) {
    return false;
  }
  if (real_uid != SUBMISSION_UID || effective_uid != SUBMISSION_UID ||
      saved_uid != SUBMISSION_UID || real_gid != SUBMISSION_GID ||
      effective_gid != SUBMISSION_GID || saved_gid != SUBMISSION_GID) {
    return false;
  }
  if (getgroups(0, NULL) != 0) return false;
  return has_no_capabilities();
}

static bool close_untrusted_descriptors(void) {
#ifdef SYS_close_range
  if (syscall(SYS_close_range, 3U, UINT_MAX, 0U) == 0) return true;
  if (errno != ENOSYS && errno != EINVAL && errno != EPERM) return false;
#endif

  struct rlimit limit = {0};
  if (getrlimit(RLIMIT_NOFILE, &limit) != 0) return false;
  rlim_t maximum = limit.rlim_cur;
  if (maximum == RLIM_INFINITY || maximum > 65536) maximum = 65536;
  for (int descriptor = 3; (rlim_t)descriptor < maximum; descriptor += 1) {
    if (close(descriptor) != 0 && errno != EBADF) return false;
  }
  return true;
}

static bool deny_syscall(scmp_filter_ctx filter, const char *name) {
  const int syscall_number = seccomp_syscall_resolve_name(name);
  if (syscall_number == __NR_SCMP_ERROR) return true;
  return seccomp_rule_add(filter, SCMP_ACT_ERRNO(EPERM), syscall_number, 0) ==
         0;
}

static bool install_submission_filter(void) {
  static const char *const denied_syscalls[] = {
      /* No submitted process needs a socket. Blocking every socket family also
       * isolates it from the root Sandbox control plane on localhost:3000. */
      "socket",       "socketpair",  "socketcall",  "connect",
      "bind",         "listen",      "accept",      "accept4",
      "getsockname",  "getpeername", "setsockopt",  "getsockopt",
      "sendto",       "recvfrom",    "sendmsg",     "recvmsg",
      "sendmmsg",     "recvmmsg",    "shutdown",

      /* io_uring can create and connect sockets without the legacy socket
       * syscalls. No judge workload requires it, so deny the whole interface. */
      "io_uring_setup", "io_uring_enter", "io_uring_register",

      /* Do not allow submissions to duplicate descriptors from another
       * process or inspect/modify a process outside their own child tree. */
      "pidfd_getfd", "ptrace", "process_vm_readv", "process_vm_writev",
  };

  scmp_filter_ctx filter = seccomp_init(SCMP_ACT_ALLOW);
  if (filter == NULL) return false;

  bool success =
      seccomp_attr_set(filter, SCMP_FLTATR_ACT_BADARCH,
                       SCMP_ACT_KILL_PROCESS) == 0 &&
      seccomp_attr_set(filter, SCMP_FLTATR_CTL_NNP, 1) == 0;
  for (size_t index = 0;
       success && index < sizeof(denied_syscalls) / sizeof(denied_syscalls[0]);
       index += 1) {
    success = deny_syscall(filter, denied_syscalls[index]);
  }
  if (success) success = seccomp_load(filter) == 0;
  seccomp_release(filter);
  return success;
}

int main(int argc, char **argv) {
  if (argc < 2 || argv[1][0] != '/') return refuse_execution();
  if (!has_submission_identity()) return refuse_execution();
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 ||
      prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0) {
    return refuse_execution();
  }
  if (!close_untrusted_descriptors() || !install_submission_filter()) {
    return refuse_execution();
  }

  execv(argv[1], &argv[1]);
  return refuse_execution();
}
