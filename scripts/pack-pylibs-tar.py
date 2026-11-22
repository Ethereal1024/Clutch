#!/usr/bin/env python3
"""Pack a prepared pylibs staging dir into a BYTE-DETERMINISTIC tar.gz.

Usage: pack-pylibs-tar.py <src-dir> <out.tar.gz>

Why this is not `tar -C <dir> -cf - agent site-packages | gzip -n` any more:
that walk is the filesystem's readdir order, and a fresh checkout on a fresh
runner hands back a different one. v0.2.0 proved it — two runs over the same
1974 files, byte-for-byte identical content, produced tars whose sha256 (and
therefore their asset names, since the name IS the hash) disagreed:

    agent-pylibs-linux-aarch64-glibc-py3.11-37df4cf252b7cb0a.tar.gz  (run #83)
    agent-pylibs-linux-aarch64-glibc-py3.11-8ef08185757ac59d.tar.gz  (run #84)

`diff` of the two member lists is empty; the difference is only the order the
members appear in. That matters beyond tidiness: the tar's sha256 is what the
remote writes to ~/.clutch-server/VERSION and compares before reinstalling, so
unstable bytes mean an identical stack is re-uploaded and reinstalled for
nothing, and every re-run of a tag leaves the previous run's tars behind on the
release as orphans nothing references.

So the archive is written from an explicitly sorted member list, and every
machine-dependent field is pinned:

  * order      — relative paths, sorted by code point (no locale in the way)
  * mtime      — 0 for every member, and 0 in the gzip header
  * uid / gid  — 0, with empty uname/gname (the runner's ids never ship)
  * modes      — dirs 0755, files 0644, or 0755 when the file is executable;
                 the staging tree's umask is not a fact about the content

The bytes are then a pure function of the tree's content, which is what lets
the caller claim `sha256(tar)` is a content hash.
"""

import gzip
import os
import pathlib
import stat
import sys
import tarfile

MB = 1024 * 1024


def members(root):
    """Every entry under root, as (posix relative name, Path), sorted by name."""
    return sorted(
        ((p.relative_to(root).as_posix(), p) for p in root.rglob("*")),
        key=lambda pair: pair[0],
    )


def packed(src, out):
    entries = members(src)
    if not entries:
        raise SystemExit(f"nothing to pack: {src} is empty")
    # mtime=0 drops the gzip header timestamp that `gzip -n` used to drop;
    # GNU_FORMAT keeps long paths readable by every tar (bsdtar included),
    # which matters because the client builds these tars on macOS as well.
    with open(out, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=6, mtime=0, fileobj=raw) as gz:
            with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tf:
                for name, path in entries:
                    info = tf.gettarinfo(str(path), arcname=name)
                    info.mtime = 0
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    if info.isdir():
                        info.mode = 0o755
                        tf.addfile(info)
                        continue
                    info.mode = 0o755 if os.stat(path).st_mode & stat.S_IXUSR else 0o644
                    with open(path, "rb") as fh:
                        tf.addfile(info, fh)


def main(argv):
    if len(argv) != 3:
        raise SystemExit("usage: pack-pylibs-tar.py <src-dir> <out.tar.gz>")
    src, out = pathlib.Path(argv[1]), argv[2]
    if not src.is_dir():
        raise SystemExit(f"not a directory: {src}")
    packed(src, out)
    size = os.path.getsize(out)
    print(f"pylibs tar packed: {out} ({size / MB:.2f} MB, {len(members(src))} members)")


if __name__ == "__main__":
    main(sys.argv)
