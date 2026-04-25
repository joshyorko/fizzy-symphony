"""Published robocorp-adapters-custom integration helpers."""

from __future__ import annotations

import json
from dataclasses import dataclass
from importlib import import_module
from typing import Any, Dict


@dataclass(frozen=True)
class RobocorpWorkitemConfig:
    """Environment contract for the published custom workitem adapters."""

    adapter: str = "robocorp_adapters_custom._sqlite.SQLiteAdapter"
    queue_name: str = "fizzy_codex_input"
    output_queue_name: str = "fizzy_codex_results"
    db_path: str = "./output/fizzy-symphony-workitems.db"
    files_dir: str = "./output/workitem-files"

    def as_env(self) -> Dict[str, str]:
        """Return environment variables consumed by robocorp-adapters-custom."""
        return {
            "RC_WORKITEM_ADAPTER": self.adapter,
            "RC_WORKITEM_QUEUE_NAME": self.queue_name,
            "RC_WORKITEM_OUTPUT_QUEUE_NAME": self.output_queue_name,
            "RC_WORKITEM_DB_PATH": self.db_path,
            "RC_WORKITEM_FILES_DIR": self.files_dir,
        }


def format_workitem_env(config: RobocorpWorkitemConfig) -> str:
    """Render the default adapter environment as JSON for copy/paste or RCC env files."""
    return json.dumps(config.as_env(), indent=2, sort_keys=True)


def adapter_package_available() -> bool:
    """Return whether the optional published adapter package can be imported."""
    try:
        import_module("robocorp_adapters_custom.workitems_integration")
    except ImportError:
        return False
    return True


def initialize_adapter_from_environment() -> Any:
    """Initialize the active adapter using robocorp-adapters-custom.

    The adapter package owns durable queue plumbing. Fizzy Symphony owns the
    Symphony-style orchestration semantics around it.
    """
    try:
        integration = import_module("robocorp_adapters_custom.workitems_integration")
    except ImportError as exc:
        raise RuntimeError(
            "Install workitem support first: pip install -e '.[workitems]' "
            "or pip install robocorp-adapters-custom."
        ) from exc

    try:
        initialize_adapter = integration.initialize_adapter
    except AttributeError as exc:
        raise RuntimeError(
            "robocorp-adapters-custom does not expose initialize_adapter()."
        ) from exc

    return initialize_adapter()
