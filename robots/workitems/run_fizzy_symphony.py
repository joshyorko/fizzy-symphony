"""Raw-Python entry point for running the Fizzy Symphony robot task."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Optional

from tasks import run_fizzy_symphony_from_environment


def load_env_json(path: Optional[Path]) -> None:
    if path is None:
        return
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"env JSON must be an object: {path}")
    for key, value in data.items():
        if value is None:
            continue
        os.environ[str(key)] = str(value)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-e", "--env-json", type=Path, help="JSON file of environment values.")
    parser.add_argument(
        "-o",
        "--output-dir",
        type=Path,
        help="Artifact/output directory. Defaults to robocorp.tasks output resolution.",
    )
    args = parser.parse_args()

    load_env_json(args.env_json)
    proof = run_fizzy_symphony_from_environment(output_dir=args.output_dir)
    print(json.dumps(proof, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
