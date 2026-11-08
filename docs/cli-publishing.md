# Publishing anchr

The PyPI package is `anchr`; its executable is `anchor`. The first release
ships a production wheel for macOS Apple Silicon. The package version comes
from the CLI's Cargo version, currently inherited from the workspace.

## One-time account setup

In [PyPI's account Publishing settings](https://pypi.org/manage/account/publishing/),
add a pending GitHub publisher with these exact values:

| Field | Value |
| --- | --- |
| PyPI project name | `anchr` |
| Owner | `amapara27` |
| Repository | `anchor` |
| Workflow filename | `publish-cli.yml` |
| Environment | `pypi` |

In GitHub, open **Settings → Environments**, create `pypi`, and configure a
required reviewer if available for the repository. The publish job uses that
environment and PyPI Trusted Publishing. No PyPI API token is needed.

A pending publisher does not reserve the name. PyPI creates the project when
the first successful upload uses it.

## Build and check locally

From the repository root:

```sh
pnpm test:e2e --only cli-package
```

This uses pinned Maturin to build a release wheel, checks its metadata, installs
and reinstalls it in a disposable uv tool directory, and runs the installed CLI
and terminal outside the checkout. The installed commands are checked without
Cargo in their PATH. Model catalogs are embedded; the optional MLX worker
continues to use its existing locked environment.

The verified wheel is copied to `target/wheels/`. The test does not publish,
install a global tool, start inference, or modify the normal model/history store.
Use `pnpm test:e2e --surface cli` for full CLI and live-runtime acceptance.

## First release

Review, commit and push the packaging changes. GitHub's **Publish CLI**
workflow can be run manually to build and check the wheel without publishing.

After those checks pass, tag the reviewed release commit. For version 1.0.0:

```sh
git tag cli-v1.0.0
git push origin cli-v1.0.0
```

The tag must match the CLI Cargo version. The macOS build job runs the CLI
fixtures and wheel installation check, then uploads that exact wheel. A
separate Ubuntu job publishes it to PyPI after the `pypi` environment's
approval rules are satisfied. GUI `v*` tags use their separate workflow.

Only the verified wheel is published. Other platforms and source distributions
need their own build and installation checks before adding them to releases.

## Install and update after publication

```sh
uv tool install anchr
anchor
uv tool upgrade anchr
```

For a one-off command, use `uvx --from anchr anchor --help`. Ollama is an
external requirement for Ollama operations; MLX setup still uses uv.

References: [Maturin binary packaging](https://www.maturin.rs/bindings#bin),
[PyPI Trusted Publishing](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/),
[uv tools](https://docs.astral.sh/uv/guides/tools/).
