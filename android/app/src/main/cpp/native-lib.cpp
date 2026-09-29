// The app's only C++: the JNI shim between the Kotlin shell and the
// nodejs-mobile libnode build (pinned v18.20.4 by
// scripts/fetch-android-libnode.sh). Three steps, nothing more:
//   1. setenv HOME/TMPDIR — every path the host JS resolves goes through
//      os.homedir()/os.tmpdir() (N2), so these two lines place ~/.clutch/…
//      inside the app sandbox;
//   2. pipe stdout/stderr into logcat (Android discards them otherwise);
//   3. run node on a worker pthread so the UI thread returns immediately.
#include <jni.h>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>

#include <cstdlib>
#include <string>
#include <vector>

#include "node.h"

namespace {

// node's console output goes to stdout/stderr, which Android drops; forward
// both into logcat under the "clutch" tag. (tunnel.log stays the richer log.)
void *log_pipe_thread(void *fdp) {
    const int fd = *static_cast<int *>(fdp);
    char buf[4096];
    ssize_t n;
    while ((n = read(fd, buf, sizeof(buf))) > 0) {
        __android_log_print(ANDROID_LOG_INFO, "clutch", "%.*s", static_cast<int>(n), buf);
    }
    return nullptr;
}

void redirectStdioToLogcat() {
    int fds[2];
    if (pipe(fds) != 0) return;
    dup2(fds[1], STDOUT_FILENO);
    dup2(fds[1], STDERR_FILENO);
    close(fds[1]);
    static int read_fd = fds[0];
    pthread_t tid;
    if (pthread_create(&tid, nullptr, log_pipe_thread, &read_fd) == 0) pthread_detach(tid);
}

struct NodeArgs {
    // storage owns the bytes; argv holds pointers into it for node::Start
    // (this pinned header's Start takes char**, not const char* const*)
    std::vector<std::string> storage;
    std::vector<char *> argv;
};

void *node_thread(void *p) {
    auto *na = static_cast<NodeArgs *>(p);
    node::Start(static_cast<int>(na->argv.size()), na->argv.data());
    return nullptr;
}

} // namespace

extern "C" JNIEXPORT jint JNICALL
Java_io_clutch_mobile_NodeEngine_startNodeWithArguments(JNIEnv *env, jclass,
                                                        jobjectArray jargs,
                                                        jstring jHome,
                                                        jstring jTmp) {
    const char *home = env->GetStringUTFChars(jHome, nullptr);
    const char *tmp = env->GetStringUTFChars(jTmp, nullptr);
    setenv("HOME", home, 1);
    setenv("TMPDIR", tmp, 1);
    env->ReleaseStringUTFChars(jHome, home);
    env->ReleaseStringUTFChars(jTmp, tmp);

    redirectStdioToLogcat();

    auto *na = new NodeArgs();
    na->storage.emplace_back("node");
    const jsize count = env->GetArrayLength(jargs);
    for (jsize i = 0; i < count; i++) {
        auto js = static_cast<jstring>(env->GetObjectArrayElement(jargs, i));
        const char *s = env->GetStringUTFChars(js, nullptr);
        na->storage.emplace_back(s);
        env->ReleaseStringUTFChars(js, s);
        env->DeleteLocalRef(js);
    }
    na->argv.reserve(na->storage.size());
    for (const auto &s : na->storage) na->argv.push_back(const_cast<char *>(s.c_str()));

    pthread_t tid;
    if (pthread_create(&tid, nullptr, node_thread, na) != 0) {
        delete na;
        return -1;
    }
    pthread_detach(tid);
    return 0;
}
