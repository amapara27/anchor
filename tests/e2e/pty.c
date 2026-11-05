// Real PTY bridge for the process E2E driver. 0xff + four bytes resizes the slave.
#ifdef __APPLE__
#include <util.h>
#else
#include <pty.h>
#endif
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <poll.h>
#include <signal.h>
#include <termios.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>

static pid_t child;
static void stop(int signal) { if (child > 0) kill(-child, signal); }
static void write_all(int fd, const void *buffer, size_t size) {
    const char *p = buffer;
    while (size) {
        ssize_t n = write(fd, p, size);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) exit(1);
        p += n; size -= n;
    }
}
int main(int argc, char **argv) {
    if (argc < 2) return 2;
    int master, slave, status = 0;
    struct winsize size = { .ws_row = 30, .ws_col = 100 };
    struct termios before, after;
    if (openpty(&master, &slave, NULL, NULL, &size) || tcgetattr(slave, &before)) return 1;
    child = fork();
    if (child < 0) return 1;
    if (!child) {
        int report = dup(2);
        fcntl(report, F_SETFD, FD_CLOEXEC);
        close(master); setsid();
        if (ioctl(slave, TIOCSCTTY, 0) < 0) _exit(1);
        dup2(slave, 0); dup2(slave, 1); dup2(slave, 2);
        if (slave > 2) close(slave);
        signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN);
        pid_t program = fork();
        if (program < 0) _exit(1);
        if (!program) {
            signal(SIGINT, SIG_DFL); signal(SIGTERM, SIG_DFL);
            execvp(argv[1], argv + 1); _exit(127);
        }
        while (waitpid(program, &status, 0) < 0 && errno == EINTR) {}
        int restored = tcgetattr(0, &after) == 0 && before.c_lflag == after.c_lflag
            && before.c_iflag == after.c_iflag && before.c_oflag == after.c_oflag;
        dprintf(report, "PTY_RESTORED=%d\n", restored);
        _exit(WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status));
    }
    signal(SIGTERM, stop); signal(SIGINT, stop);
    unsigned char resize[4]; int pending = -1, input_open = 1;
    for (;;) {
        struct pollfd fds[] = {{master, POLLIN, 0}, {input_open ? 0 : -1, POLLIN, 0}};
        if (poll(fds, 2, 100) < 0 && errno != EINTR) break;
        if (fds[0].revents & (POLLIN | POLLHUP)) {
            char buffer[8192]; ssize_t n = read(master, buffer, sizeof(buffer));
            if (n > 0) write_all(1, buffer, n);
            else break;
        }
        if (fds[1].revents & (POLLIN | POLLHUP)) {
            unsigned char buffer[4096]; ssize_t n = read(0, buffer, sizeof(buffer));
            if (n <= 0) { input_open = 0; stop(SIGTERM); }
            for (ssize_t i = 0; i < n; i++) {
                if (pending >= 0) {
                    resize[pending++] = buffer[i];
                    if (pending == 4) {
                        size.ws_row = (resize[0] << 8) | resize[1];
                        size.ws_col = (resize[2] << 8) | resize[3];
                        ioctl(master, TIOCSWINSZ, &size); pending = -1;
                    }
                } else if (buffer[i] == 255) pending = 0;
                else {
                    ssize_t end = i + 1;
                    while (end < n && buffer[end] != 255) end++;
                    write_all(master, buffer + i, end - i);
                    i = end - 1;
                }
            }
        }
        if (waitpid(child, &status, WNOHANG) == child) {
            // Drain the final restore sequence before reporting exit.
            char buffer[8192]; ssize_t n;
            while ((n = read(master, buffer, sizeof(buffer))) > 0) write_all(1, buffer, n);
            break;
        }
    }
    waitpid(child, &status, 0);
    close(master); close(slave);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
