# CLI guide

The `anchor` CLI shares the desktop app's Rust services, database, chat history, and benchmark history.

Run `anchor` (or `anchor tui`) in a terminal. Type `/` at the prompt to search commands, Tab to complete and Enter to run. Ollama and MLX are listed in the header. Use `/runtime` to choose one or type `/runtime mlx` directly. `/model` picks a local model, `/models` manages installed models, and `/library` finds downloads. `/bench` opens setup and asks for a model if needed. `/results`, `/leaderboard` and `/sessions` browse saved measurements. Type to filter lists, use arrows or Page Up/Down to move, and press Enter for the primary action or Tab for more actions. Escape returns to the previous view. In a conversation, type at the prompt and press Enter to reply; replies stream into the transcript. Confirmations accept `y` or `n`. Ctrl-C clears the prompt, and pressing it twice quits. Ctrl-L refreshes, and `/help` shows controls.

Jobs stay visible across navigation. `/activity` shows the current or last job, including benchmark progress and a summary of decode rate and time to first token. Ctrl-C stops a running job; a second press forces it. `/quit` confirms stopping active work before exiting. Benchmark, chat and preset drafts survive Escape until submitted. Evidence export asks for a new filename and includes prompts/output; it never overwrites an existing file. The workspace requires a real terminal; explicit commands and `--json` remain available for scripts. MLX provides model downloads and benchmarking; chat, comparison, memory fit and store cleanup retain their existing Ollama scope.

```bash
anchor models ls                            # installed models
anchor models browse --filter qwen          # everything on ollama.com
anchor models catalog --runtime mlx         # supported pinned MLX checkpoints
anchor models pull mlx-community/gemma-3-270m-it-4bit --runtime mlx
anchor models compare llama3.2:1b qwen3.5:9b "why is the sky blue?"
anchor fit deepseek-v2 --ctx 32768          # weights + KV cache + verdict
anchor chat -m llama3.2:1b                  # interactive; omit -m to continue with --conversation
anchor bench scenarios                      # what the suite measures
anchor bench run llama3.2:1b --repeats fast
anchor bench run llama3.2:1b --scenario classify --repeats fast
anchor bench run mlx-community/gemma-3-270m-it-4bit --runtime mlx --repeats fast
anchor bench ls --runtime mlx                # saved results, no live runtime needed
anchor bench top --scenario balanced        # rank every model on one scenario
anchor bench sessions                       # includes failed/cancelled executions
anchor bench export SESSION_ID --include-content > evidence.json
anchor bench replay evidence.json           # offline recalculation from raw evidence
anchor bench validate llama3.2:1b            # validate Ollama measurements (calibrate remains an alias)
anchor bench report SESSION_ID              # saved settings and validation reports
anchor bench calibrate llama3.2:1b --output ./calibration  # isolated DB + full synthetic evidence
node tools/calibrate-ollama.mjs ./calibration/SESSION_ID.json  # independent replay/arithmetic check
anchor storage scan
anchor settings server --start
```

Use `--json` for scripting and `--host` to point at a non-default Ollama. JSON stdout contains the result; progress and errors go to stderr. Interactive chat requires a prompt, `--file PATH` or `--stdin` when using JSON. One-shot chat returns its conversation ID, model, cancellation state and response/thinking/stats. Comparison returns both slot outcomes and exits nonzero if either fails. Successful commands return 0, operational failures 1, argument errors 2 and interrupted work 130; a declined deletion returns a `declined` result without changing data.

`models ls|info|browse|pull` and `bench run|ls|top|samples` accept `--runtime ollama|mlx` (default Ollama). MLX accepts a supported downloaded catalog ID or a local checkpoint directory for execution. `bench top --runtime mlx` requires `--model` or `--reference` to keep tokenizer/template/runtime comparisons compatible; rankings default to the balanced workload. Sessions span both runtimes unless filtered with `--runtime`. Ollama and MLX rates/memory remain runtime-scoped. CLI repeats retain their existing Thorough default; use `--repeats fast` to match the GUI default.

Create or edit a preset with `anchor settings presets save ID --name NAME --system TEXT --num-ctx 8192`; unspecified fields stay unchanged, and `--clear system,num-ctx` restores runtime defaults for those fields. `anchor chat preset CONVERSATION_ID PRESET_ID` assigns it; omit the preset ID to return to the default. `--preset` also applies when continuing a conversation. `anchor chat regenerate CONVERSATION_ID` replaces the newest assistant turn using its original prompt. Chat and comparison accept `--file PATH` or `--stdin` for longer prompts.

Anything that deletes — `models rm`, `chat rm`, `storage clean` — asks first, and takes `--yes` to skip the prompt. The prompt reads from stdin, so a piped or redirected invocation without `--yes` declines rather than proceeding; scripts need the flag. The first Ctrl-C gracefully stops chat, comparisons, downloads and benchmark/validation runs. Partial chat output is saved; completed benchmark results and interrupted execution evidence are retained. Press Ctrl-C twice to exit immediately.

The app and CLI run as separate processes over the same Rust services and database. An OS-owned work lock refuses competing inference/measurement and model unload/removal operations; ordinary reads remain available, and the lock releases when an owner exits or crashes. Other applications and raw Ollama clients do not participate in this lock, so close unrelated inference work before benchmarking.
