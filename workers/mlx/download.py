"""Download pinned catalog files; never import or execute checkpoint code."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time


def emit(kind, **fields):
    print(json.dumps(dict(kind=kind, **fields)), flush=True)


def watch_parent():
    while os.read(sys.stdin.fileno(), 4096):
        pass
    os._exit(2)


def main():
    request = json.loads(sys.stdin.readline())
    threading.Thread(target=watch_parent, daemon=True).start()
    from huggingface_hub import hf_hub_download
    from tqdm.auto import tqdm

    model = request["model"]
    cache = Path(request["cache_dir"])
    snapshot = cache / ("models--" + model["id"].replace("/", "--")) / "snapshots" / model["revision"]
    total = sum(f["bytes"] for f in model["files"])
    completed = 0
    last_update = 0

    def progress(status, current=0):
        emit("progress", progress=dict(status=status, completed=min(total, completed + current), total=total))

    class Progress(tqdm):
        def display(self, *args, **kwargs):
            pass

        def update(self, n=1):
            nonlocal last_update
            result = super().update(n)
            if time.monotonic() - last_update >= 0.2:
                progress("Downloading " + file["name"], min(self.n, file["bytes"]))
                last_update = time.monotonic()
            return result

    def matches(path, file):
        if path.stat().st_size != file["bytes"]:
            return False
        h = hashlib.sha256() if file["sha256"] else hashlib.sha1()
        if not file["sha256"]:
            h.update(f'blob {file["bytes"]}\0'.encode())
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest() == (file["sha256"] or file["git_sha1"])

    for file in model["files"]:
        if Path(file["name"]).name != file["name"]:
            raise ValueError("Catalog filenames must stay within the checkpoint folder")
        progress("Downloading " + file["name"])
        kwargs = dict(repo_id=model["id"], revision=model["revision"], filename=file["name"],
                      cache_dir=str(cache), token=False, endpoint="https://huggingface.co", tqdm_class=Progress)
        path = Path(hf_hub_download(**kwargs, local_files_only=(snapshot / file["name"]).is_file()))
        progress("Verifying " + file["name"], file["bytes"])
        if not matches(path, file):
            path = Path(hf_hub_download(**kwargs, force_download=True))
            # Hub can leave an existing snapshot file pointing at stale content.
            if not matches(path, file):
                blob = snapshot.parent.parent / "blobs" / (file["sha256"] or file["git_sha1"])
                if blob.is_file() and matches(blob, file):
                    with tempfile.TemporaryDirectory(prefix=".anchor-repair-", dir=snapshot) as staging:
                        link = Path(staging) / file["name"]
                        link.symlink_to(blob.resolve())
                        link.replace(path)
            if not matches(path, file):
                raise ValueError("File checksum did not match the pinned catalog: " + file["name"])
        completed += file["bytes"]
        progress("Files verified")
    emit("complete", path=str(snapshot))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit("error", error=f"{type(error).__name__}: {error}")
        sys.exit(1)
