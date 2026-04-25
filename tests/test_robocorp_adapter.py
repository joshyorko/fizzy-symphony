import sys
import types

import pytest

from fizzy_symphony.robocorp_adapter import (
    RobocorpWorkitemConfig,
    format_workitem_env,
    initialize_adapter_from_environment,
)


def test_workitem_config_formats_published_adapter_env():
    config = RobocorpWorkitemConfig()
    env_text = format_workitem_env(config)

    assert '"RC_WORKITEM_ADAPTER": "robocorp_adapters_custom._sqlite.SQLiteAdapter"' in env_text
    assert '"RC_WORKITEM_QUEUE_NAME": "fizzy_codex_input"' in env_text


def test_initialize_adapter_from_environment_uses_published_package(monkeypatch):
    package = types.ModuleType("robocorp_adapters_custom")
    integration = types.ModuleType("robocorp_adapters_custom.workitems_integration")
    adapter = object()
    integration.initialize_adapter = lambda: adapter

    monkeypatch.setitem(sys.modules, "robocorp_adapters_custom", package)
    monkeypatch.setitem(sys.modules, "robocorp_adapters_custom.workitems_integration", integration)

    assert initialize_adapter_from_environment() is adapter


def test_initialize_adapter_from_environment_reports_missing_dependency(monkeypatch):
    monkeypatch.setitem(sys.modules, "robocorp_adapters_custom", None)
    monkeypatch.setitem(sys.modules, "robocorp_adapters_custom.workitems_integration", None)

    with pytest.raises(RuntimeError, match="Install workitem support"):
        initialize_adapter_from_environment()
