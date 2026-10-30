"""Real text generation for Anchor's shared scenario catalog; upstream rates stay diagnostic."""
import contextlib
import gc
import hashlib
import importlib
import json
from pathlib import Path
import sys
import time

from __main__ import checkpoint, commands, digest, emit, memory, origin, validate


def run_suite(request, path, files, config, identity, source_paths, mx, stream, load, make_prompt_cache):
    plans = request["attempts"]
    if not 0 < len(plans) <= 32:
        raise ValueError("Unsupported suite attempt budget")
    generation = importlib.import_module("mlx_lm.generate")
    generation_stream = generation.generation_stream
    streams = [stream, generation_stream]
    generation_hash = digest(Path(generation.__file__))
    model = tokenizer = None
    for index, plan in enumerate(plans):
        if index > 0 and commands.get() != {"next": index}:
            raise ValueError("Missing persisted-attempt acknowledgement")
        emit("attempt_started", plan_index=index)
        try:
            if model is None:
                with mx.stream(stream):
                    validate(mx, stream)
                    mx.synchronize(stream)
                    mx.clear_cache()
                    baseline = memory(mx)
                    mx.reset_peak_memory()
                    start = time.perf_counter_ns()
                    with contextlib.redirect_stdout(sys.stderr):
                        model, tokenizer = load(str(path), tokenizer_config={"trust_remote_code": False, "local_files_only": True}, lazy=True)
                    mx.eval(model.parameters())
                    mx.synchronize(stream)
                    emit("mlx_load", duration_ns=time.perf_counter_ns() - start, baseline=baseline, memory=memory(mx))
                loaded_files, _ = checkpoint(path)
                if loaded_files != files:
                    raise ValueError("Checkpoint changed while loading")
            req = plan["request"]
            cap, context = req["num_predict"], req["num_ctx"]
            if not 0 < cap <= 4096 or not 0 < context <= identity["context_capacity"] or req["temperature"] != 0:
                raise ValueError("Unsupported sampling/output/context configuration")
            rendered = tokenizer.apply_chat_template([{"role": "user", "content": req["prompt"]}], tokenize=False, add_generation_prompt=True, enable_thinking=False) if tokenizer.chat_template else req["prompt"]
            ids = tokenizer.encode(rendered, add_special_tokens=False)
            if not ids or len(ids) + cap > context:
                raise ValueError("Formatted input plus output cap exceeds the requested context; truncation is disabled")
            cache = make_prompt_cache(model)
            if not cache or any(not c.empty() or getattr(c, "offset", 0) != 0 for c in cache):
                raise ValueError("Each request requires a fresh, empty model-native cache")
            cache_types = [type(c).__module__ + "." + type(c).__name__ for c in cache]
            template = json.dumps(tokenizer.chat_template, sort_keys=True)
            emit("mlx_input", request=req, ids=ids, rendered=rendered, context=context, model_digest=identity["model_digest"],
                 cache_offsets=[getattr(c, "offset", None) for c in cache], cache_empty=[c.empty() for c in cache], cache_types=cache_types,
                 template_sha256=hashlib.sha256(template.encode()).hexdigest(), generator_sha256=generation_hash)
            for s in streams:
                mx.synchronize(s)
            mx.clear_cache()
            baseline = memory(mx)
            mx.reset_peak_memory()
            emit("mlx_window_start", baseline=baseline, after_reset=memory(mx), streams=[str(s) for s in streams])
            start = time.perf_counter_ns()
            samples = []
            final = None
            for response in generation.stream_generate(model, tokenizer, ids, max_tokens=cap, prompt_cache=cache):
                samples.append(response.token)
                emit("generation", response=response.text, done=False, token_id=response.token, generation_tokens=response.generation_tokens)
                final = response
            for s in streams:
                mx.synchronize(s)
            elapsed = time.perf_counter_ns() - start
            scoped = memory(mx)
            if final is None or len(samples) != final.generation_tokens:
                raise ValueError("Missing or inconsistent generation counters")
            emit("generation", response="", done=True, done_reason=final.finish_reason,
                 prompt_eval_count=len(ids), prompt_eval_cached_count=0, eval_count=final.generation_tokens, total_duration=elapsed,
                 mlx=dict(protocol_version=request["protocol_version"], prompt_tps=final.prompt_tps, generation_tps=final.generation_tps,
                          token_ids=samples, eos_token_ids=list(tokenizer.eos_token_ids), memory=scoped,
                          upstream_peak_memory_gb=final.peak_memory, cache_offsets=[getattr(c, "offset", None) for c in cache],
                          cache_types=[type(c).__module__ + "." + type(c).__name__ for c in cache]))
            del cache, final, response
            gc.collect()
            emit("attempt_finished", plan_index=index, outcome="completed")
        except Exception as error:
            emit("attempt_finished", plan_index=index, outcome="invalid" if isinstance(error, ValueError) else "failed", error=f"{type(error).__name__}: {error}")
            emit("session_finished", outcome="failed", identity_unchanged=False)
            return
    after, _ = checkpoint(path)
    unchanged = after == files and all(digest(p) == identity["sources"][name] for name, p in source_paths.items()) and digest(Path(generation.__file__)) == generation_hash
    emit("session_finished", outcome="completed" if unchanged else "invalid", identity_unchanged=unchanged)
