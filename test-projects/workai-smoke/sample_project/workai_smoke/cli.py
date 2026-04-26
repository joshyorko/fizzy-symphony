"""Small CLI that smoke-test cards can ask Codex to edit."""

from __future__ import annotations

import argparse
from typing import List


def greeting(name: str) -> str:
    return f"Hello, {name}."


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("name")
    args = parser.parse_args(argv)
    print(greeting(args.name))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
