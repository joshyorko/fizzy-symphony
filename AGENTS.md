# Repository Guidelines

## Project Structure & Module Organization

`fizzy-symphony` Python package, `src/` layout. Runtime code in `src/fizzy_symphony/`: `models.py` dataclasses, `tracker.py` adapter contract, `commands.py` command builders, `cli.py` console entry, `adapters/fizzy_cli.py` dry-run Fizzy CLI commands. Tests in `tests/`, mirroring package areas. Support files: `docs/`, `prompts/`, `examples/`, `SPEC.md`, `WORKFLOW.example.md`.

## Build, Test, and Development Commands

Use project env or devcontainer, not global Bluefin host tooling.

```bash
python -m pip install -e ".[dev]"
python -m pytest
python -m pytest --cov
python -m compileall src
fizzy-symphony list --board work-ai-board --dry-run
```

`pip install -e ".[dev]"` installs package + test tools. `pytest` runs suite under `tests/`. `pytest --cov` reports `fizzy_symphony` coverage. `compileall` catches syntax/import issues. CLI commands currently dry-run only.

## Coding Style & Naming Conventions

Target Python 3.9+. Use 4-space indent, type hints for contracts, small functions, explicit returns. Modules: lowercase_with_underscores. Tests: `test_*.py`, functions `test_<behavior>`, helper factories with leading underscore, matching `_make_agent` / `_make_config`. Prefer stdlib unless dependency justified in `pyproject.toml`.

## Testing Guidelines

Project uses `pytest`; verbose output configured in `pyproject.toml`. Add tests for each behavior change, especially command string generation, CLI output, dataclass defaults, adapter dry-run behavior. Keep assertions concrete; verify exact Fizzy command strings when possible. Coverage targets `fizzy_symphony`; run `python -m pytest --cov` before broad refactors.

## Commit & Pull Request Guidelines

History uses short imperative Conventional Commit-style subjects, e.g. `feat: add dry-run Fizzy adapter scaffold`, `test: tighten fizzy cli plan coverage`. Keep commits focused; include tests/docs with code changes. PRs need behavior summary, verification commands, linked cards/issues when available, and CLI output examples for user-visible command changes.

## Agent-Specific Instructions

Preserve safety boundary: adapter flows build dry-run Fizzy commands; no external tracker mutations unless spec + tests deliberately change. Keep `SPEC.md`, `README.md`, and tests synced when changing workflow states, command contracts, or CLI behavior.
