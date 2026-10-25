"""Exclusive native compute worker. stdout is versioned NDJSON; timings are not HTTP latency."""
import contextlib
import gc
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import platform
import queue
import sys
import threading
import time

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false")
PROTOCOL = 1
origin = time.perf_counter_ns()
commands = queue.Queue()


def emit(kind, **fields):
    print(json.dumps(dict(kind=kind, worker_ns=time.perf_counter_ns() - origin, **fields), allow_nan=False), flush=True)


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def checkpoint(path):
    config = json.loads((path / "config.json").read_text())
    if config.get("model_type") != "llama":
        raise ValueError("This worker currently supports MLX-LM Llama checkpoints only")
    if not list(path.glob("*.safetensors")):
        raise ValueError("Choose a local MLX checkpoint with safetensors weights")
    files = [p for p in sorted(path.iterdir()) if p.is_file() and p.suffix in (".json", ".safetensors", ".model", ".tiktoken", ".jinja", ".txt")]
    records = [dict(name=p.name, bytes=p.stat().st_size, sha256=digest(p)) for p in files]
    return records, config


def memory(mx):
    return dict(active_bytes=mx.get_active_memory(), cache_bytes=mx.get_cache_memory(), peak_bytes=mx.get_peak_memory())


def watch_parent():
    # A crashed host must not strand a GPU worker; the host keeps stdin open while alive.
    pending = b""
    while chunk := os.read(sys.stdin.fileno(), 4096):
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            try:
                commands.put(json.loads(line))
            except ValueError:
                commands.put({"error": "invalid host command"})
    os._exit(2)


def validate(mx, stream):
    mx.synchronize(stream)
    mx.clear_cache()
    baseline = memory(mx)
    live = mx.ones((2 * 1024 * 1024,), dtype=mx.float32)
    mx.eval(live)
    mx.synchronize(stream)
    resident = memory(mx)
    mx.reset_peak_memory()
    reset = memory(mx)
    extra = mx.ones((4 * 1024 * 1024,), dtype=mx.float32)
    mx.eval(extra)
    mx.synchronize(stream)
    allocated = memory(mx)
    del extra
    gc.collect()
    mx.synchronize(stream)
    freed = memory(mx)
    mx.clear_cache()
    cleared = memory(mx)
    del live
    gc.collect()
    mx.synchronize(stream)
    mx.clear_cache()

    a = mx.full((512, 512), 1 / 512, dtype=mx.float32)
    mx.eval(a)
    mx.synchronize(stream)
    start = time.perf_counter_ns()
    z = a
    for _ in range(8):
        z = z @ a
    built = time.perf_counter_ns()
    mx.eval(z)
    mx.synchronize(stream)
    completed = time.perf_counter_ns()
    value = z[0, 0].item()
    auxiliary = mx.new_stream(mx.gpu)
    with mx.stream(auxiliary):
        other = a @ a
        mx.async_eval(other)
    mx.synchronize(auxiliary)
    other_value = other[0, 0].item()
    checks = dict(
        live_allocation=resident["active_bytes"] >= baseline["active_bytes"] + 8 * 1024**2,
        reset_preserves_live=reset["active_bytes"] == resident["active_bytes"] and reset["peak_bytes"] in (0, reset["active_bytes"]),
        allocation_peak=allocated["peak_bytes"] >= allocated["active_bytes"] >= resident["active_bytes"] + 16 * 1024**2,
        release_and_cache=freed["active_bytes"] < allocated["active_bytes"] and freed["peak_bytes"] == allocated["peak_bytes"] and cleared["cache_bytes"] <= freed["cache_bytes"],
        evaluated_output=math.isclose(value, 1 / 512, rel_tol=1e-5) and start < built < completed,
        explicit_auxiliary_stream=math.isclose(other_value, 1 / 512, rel_tol=1e-5),
    )
    emit("boundary_validation", checks=checks, baseline=baseline, live=resident, reset=reset, allocated=allocated,
         freed=freed, cleared=cleared, allocation_bytes=[8 * 1024**2, 16 * 1024**2],
         graph_build_ns=built - start, evaluation_and_sync_ns=completed - built,
         completed_work_ns=completed - start, expected_value=1 / 512, value=value, auxiliary_value=other_value,
         stream=str(stream), auxiliary_stream=str(auxiliary), reset_behavior="zero" if reset["peak_bytes"] == 0 else "live_baseline")
    if not all(checks.values()):
        raise ValueError("MLX timing/allocator boundary validation failed")


def inference(mx, model, make_prompt_cache, stream, prompt_ids, decode_ids):
    cache = make_prompt_cache(model)
    if not cache or any(type(c).__name__ != "KVCache" for c in cache):
        raise ValueError("Unsupported KV cache: native count validation requires standard KVCache")
    prompt = mx.array([prompt_ids], dtype=mx.uint32)
    inputs = [mx.array([[token]], dtype=mx.uint32) for token in decode_ids]
    mx.eval(prompt, inputs)
    mx.synchronize(stream)
    mx.clear_cache()
    baseline = memory(mx)
    mx.reset_peak_memory()
    emit("window_reset", baseline=baseline, after_reset=memory(mx), stream=str(stream))
    start = time.perf_counter_ns() - origin
    logits = model(prompt, cache=cache)[:, -1, :]
    mx.eval(logits, [c.state for c in cache])
    mx.synchronize(stream)
    end = time.perf_counter_ns() - origin
    emit("phase", phase="prompt", start_ns=start, end_ns=end, tokens=len(prompt_ids), cache_offsets=[c.offset for c in cache])
    del logits
    start = time.perf_counter_ns() - origin
    for token in inputs:
        logits = model(token, cache=cache)[:, -1, :]
        mx.async_eval(logits, [c.state for c in cache])
    mx.eval(logits, [c.state for c in cache])
    mx.synchronize(stream)
    end = time.perf_counter_ns() - origin
    scoped = memory(mx)
    sampled = time.perf_counter_ns() - origin
    value = logits[0, 0].item()
    emit("phase", phase="decode", start_ns=start, end_ns=end, tokens=len(decode_ids), cache_offsets=[c.offset for c in cache])
    emit("window_end", memory=scoped, sampled_ns=sampled, finite_output=math.isfinite(value), output_probe=value)
    if not math.isfinite(value):
        raise ValueError("Nonfinite model output")
    del logits, cache, prompt, inputs
    gc.collect()
    mx.synchronize(stream)


def main():
    request = json.loads(sys.stdin.readline())
    if request.get("protocol_version") != PROTOCOL:
        raise ValueError("Unsupported MLX worker protocol")
    path = Path(request["model_path"]).expanduser().resolve(strict=True)
    files, config = checkpoint(path)
    suite = request.get("mode") == "suite"
    if not suite and (not 0 < request["prompt_tokens"] <= 2048 or not 0 < request["decode_steps"] <= 256 or not 1 <= request["repeats"] <= 10):
        raise ValueError("Native workload exceeds the supported bounds")
    if not suite and request["prompt_tokens"] + request["decode_steps"] > config.get("max_position_embeddings", 0):
        raise ValueError("Native workload exceeds the checkpoint context capacity")
    with contextlib.redirect_stdout(sys.stderr):
        import mlx.core as mx
        from mlx_lm import load
        from mlx_lm.models.cache import make_prompt_cache
        import mlx_lm.models.llama as llama
        import mlx_lm.models.cache as cache_module
        import mlx_lm.utils as utils
    if not mx.metal.is_available():
        raise ValueError("Native MLX measurements require an Apple Silicon GPU")
    stream = mx.new_stream(mx.gpu)
    versions = {name: importlib.metadata.version(name) for name in ("mlx", "mlx-lm", "transformers")}
    source_paths = {name: Path(module.__file__) for name, module in (("worker", sys.modules[__name__]), ("mlx_core", mx), ("llama", llama), ("cache", cache_module), ("loader", utils))}
    source_paths.update(lock=Path(__file__).with_name("uv.lock"), project=Path(__file__).with_name("pyproject.toml"), suite=Path(__file__).with_name("suite.py"), python_version=Path(__file__).with_name(".python-version"))
    source_paths["generator"] = Path(utils.__file__).with_name("generate.py")
    for binary in (Path(mx.__file__).parent / "lib").glob("*"):
        if binary.is_file() and binary.suffix in (".dylib", ".metallib"):
            source_paths[binary.name] = binary
    sources = {name: digest(p) for name, p in source_paths.items()}
    identity = dict(model_files=files, model_digest=hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest(),
                    versions=versions, python=platform.python_version(), platform=platform.platform(), sources=sources,
                    device=mx.device_info(), quantization=config.get("quantization"), model_type=config["model_type"],
                    context_capacity=config["max_position_embeddings"], vocab_size=config["vocab_size"], stream=str(stream), worker_pid=os.getpid())
    tokenizer_files = [f for f in files if "token" in f["name"] or f["name"].endswith((".jinja", ".model", ".tiktoken")) or f["name"] == "merges.txt"]
    identity["tokenizer_fingerprint"] = hashlib.sha256(json.dumps(tokenizer_files, sort_keys=True).encode()).hexdigest()
    emit("manifest", protocol_version=PROTOCOL, identity=identity)
    if json.loads(sys.stdin.readline()) != {"run": True}:
        raise ValueError("Missing frozen-plan acknowledgement")
    threading.Thread(target=watch_parent, daemon=True).start()
    if suite:
        from suite import run_suite
        run_suite(request, path, files, config, identity, source_paths, mx, stream, load, make_prompt_cache)
        return
    steps = ["boundary_validation", "load", "warmup"] + ["native_repeat"] * request["repeats"] + ["identity_check"]
    with mx.stream(stream):
        for index, step in enumerate(steps):
            if index > 0 and commands.get() != {"next": index}:
                raise ValueError("Missing persisted-attempt acknowledgement")
            emit("attempt_started", plan_index=index)
            try:
                if step == "boundary_validation":
                    validate(mx, stream)
                elif step == "load":
                    mx.synchronize(stream)
                    mx.clear_cache()
                    baseline = memory(mx)
                    mx.reset_peak_memory()
                    emit("window_reset", baseline=baseline, after_reset=memory(mx), stream=str(stream))
                    start = time.perf_counter_ns() - origin
                    with contextlib.redirect_stdout(sys.stderr):
                        model, tokenizer = load(str(path), tokenizer_config={"trust_remote_code": False, "local_files_only": True}, lazy=True)
                    mx.eval(model.parameters())
                    mx.synchronize(stream)
                    end = time.perf_counter_ns() - origin
                    emit("phase", phase="load", start_ns=start, end_ns=end, tokens=0)
                    scoped = memory(mx)
                    emit("window_end", memory=scoped, sampled_ns=time.perf_counter_ns() - origin, finite_output=True)
                    base_ids = tokenizer.encode("A lighthouse guides ships safely through dark water.", add_special_tokens=False)
                    if not base_ids:
                        raise ValueError("Tokenizer produced no synthetic input tokens")
                    prompt_ids = [base_ids[i % len(base_ids)] for i in range(request["prompt_tokens"])]
                    decode_ids = [base_ids[i % len(base_ids)] for i in range(request["decode_steps"])]
                    emit("token_plan", prompt_ids=prompt_ids, decode_ids=decode_ids, prior_context_tokens=0,
                         eos_policy="fixed synthetic inputs; no sampling or EOS stop", chat_template="not applied: native synthetic compute")
                elif step == "identity_check":
                    after, _ = checkpoint(path)
                    unchanged = after == files and all(digest(p) == sources[name] for name, p in source_paths.items())
                    emit("identity_check", unchanged=unchanged)
                    if not unchanged:
                        raise ValueError("Checkpoint or runtime source changed during measurement")
                else:
                    inference(mx, model, make_prompt_cache, stream, prompt_ids, decode_ids)
                emit("attempt_finished", plan_index=index, outcome="completed")
            except Exception as error:
                emit("attempt_finished", plan_index=index, outcome="failed", error=f"{type(error).__name__}: {error}")
                emit("session_finished", outcome="failed")
                return
    emit("session_finished", outcome="completed")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit("error", error=f"{type(error).__name__}: {error}")
        sys.exit(1)
