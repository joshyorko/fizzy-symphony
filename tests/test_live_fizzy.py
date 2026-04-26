import subprocess

import pytest

from fizzy_symphony.live_fizzy import FizzyLiveClient, FizzyLiveClientError


def _client(**kwargs):
    defaults = {"fizzy_bin": "fizzy"}
    defaults.update(kwargs)
    return FizzyLiveClient(**defaults)


def _recording_run(monkeypatch, stdout='{"ok": true}'):
    calls = []

    def fake_run(command, text, capture_output, check, timeout):
        calls.append(
            {
                "command": command,
                "text": text,
                "capture_output": capture_output,
                "check": check,
                "timeout": timeout,
            }
        )
        return subprocess.CompletedProcess(command, 0, stdout=stdout, stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    return calls


def test_read_commands_parse_json_and_use_agent_quiet(monkeypatch):
    calls = _recording_run(monkeypatch, stdout='{"id": "board_1"}')
    client = _client()

    assert client.board_show("board_1") == {"id": "board_1"}
    assert client.board_list() == {"id": "board_1"}
    assert client.column_list("board_1") == {"id": "board_1"}
    assert client.card_list("board_1") == {"id": "board_1"}
    assert client.card_show(42) == {"id": "board_1"}
    assert client.comment_list(42) == {"id": "board_1"}
    assert client.doctor() == {"id": "board_1"}

    assert [call["command"] for call in calls] == [
        ["fizzy", "board", "show", "board_1", "--agent", "--quiet"],
        ["fizzy", "board", "list", "--all", "--agent", "--quiet"],
        ["fizzy", "column", "list", "--board", "board_1", "--agent", "--quiet"],
        ["fizzy", "card", "list", "--board", "board_1", "--all", "--agent", "--quiet"],
        ["fizzy", "card", "show", "42", "--agent", "--quiet"],
        ["fizzy", "comment", "list", "--card", "42", "--agent", "--quiet"],
        ["fizzy", "doctor", "--agent", "--quiet"],
    ]
    assert all(call["text"] is True for call in calls)
    assert all(call["capture_output"] is True for call in calls)
    assert all(call["check"] is False for call in calls)
    assert all(call["timeout"] == 30.0 for call in calls)


def test_create_commands_parse_json_and_use_local_cli_flags(monkeypatch):
    calls = _recording_run(monkeypatch, stdout='{"id": "created"}')
    client = _client(fizzy_bin="/opt/bin/fizzy")

    assert client.board_create("Work AI") == {"id": "created"}
    assert client.column_create("board_1", "Ready for Agents") == {"id": "created"}
    assert client.card_create("board_1", "Do work", "Detailed prompt") == {"id": "created"}
    assert client.card_create("board_1", "Title only") == {"id": "created"}

    assert [call["command"] for call in calls] == [
        ["/opt/bin/fizzy", "board", "create", "--name", "Work AI", "--agent", "--quiet"],
        [
            "/opt/bin/fizzy",
            "column",
            "create",
            "--board",
            "board_1",
            "--name",
            "Ready for Agents",
            "--agent",
            "--quiet",
        ],
        [
            "/opt/bin/fizzy",
            "card",
            "create",
            "--board",
            "board_1",
            "--title",
            "Do work",
            "--description",
            "Detailed prompt",
            "--agent",
            "--quiet",
        ],
        [
            "/opt/bin/fizzy",
            "card",
            "create",
            "--board",
            "board_1",
            "--title",
            "Title only",
            "--agent",
            "--quiet",
        ],
    ]


def test_card_mutation_commands_use_visible_card_numbers(monkeypatch):
    calls = _recording_run(monkeypatch, stdout="")
    client = _client()

    assert client.card_golden(579) is None
    assert client.card_tag(579, "agent-instructions") is None
    assert client.comment_create(579, "Proof attached.") is None
    assert client.card_column(579, "col_ready") is None
    assert client.card_close(579) is None
    assert client.card_postpone(579) is None
    assert client.card_untriage(579) is None

    assert [call["command"] for call in calls] == [
        ["fizzy", "card", "golden", "579", "--agent", "--quiet"],
        ["fizzy", "card", "tag", "579", "--tag", "agent-instructions", "--agent", "--quiet"],
        ["fizzy", "comment", "create", "--card", "579", "--body", "Proof attached.", "--agent", "--quiet"],
        ["fizzy", "card", "column", "579", "--column", "col_ready", "--agent", "--quiet"],
        ["fizzy", "card", "close", "579", "--agent", "--quiet"],
        ["fizzy", "card", "postpone", "579", "--agent", "--quiet"],
        ["fizzy", "card", "untriage", "579", "--agent", "--quiet"],
    ]


@pytest.mark.parametrize(
    "card_number",
    [
        "card_579",
        True,
        False,
        0,
        -1,
        "0",
        "-1",
        "01",
        "００１",
        "٤٢",
    ],
)
def test_card_mutations_reject_non_visible_number_values(monkeypatch, card_number):
    calls = _recording_run(monkeypatch, stdout="")

    with pytest.raises(ValueError, match="visible card number"):
        _client().card_close(card_number)

    assert calls == []


@pytest.mark.parametrize("card_number", [1, "1", 579, "579"])
def test_card_mutations_accept_positive_ascii_visible_numbers(monkeypatch, card_number):
    calls = _recording_run(monkeypatch, stdout="")

    assert _client().card_close(card_number) is None

    assert calls == [
        {
            "command": ["fizzy", "card", "close", str(card_number), "--agent", "--quiet"],
            "text": True,
            "capture_output": True,
            "check": False,
            "timeout": 30.0,
        }
    ]


def test_nonzero_exit_raises_clear_error(monkeypatch):
    def fake_run(command, text, capture_output, check, timeout):
        return subprocess.CompletedProcess(command, 17, stdout="", stderr="nope")

    monkeypatch.setattr(subprocess, "run", fake_run)

    with pytest.raises(
        FizzyLiveClientError,
        match="fizzy card show 42 --agent --quiet failed with exit code 17: nope",
    ):
        _client().card_show(42)


@pytest.mark.parametrize(
    ("error", "match"),
    [
        (FileNotFoundError("missing fizzy"), "installed, executable, and available on PATH"),
        (OSError("permission denied"), "Unable to run Fizzy CLI command fizzy doctor --agent --quiet"),
    ],
)
def test_subprocess_setup_errors_raise_clear_client_error(monkeypatch, error, match):
    def fake_run(command, text, capture_output, check, timeout):
        raise error

    monkeypatch.setattr(subprocess, "run", fake_run)

    with pytest.raises(FizzyLiveClientError, match=match):
        _client().doctor()


def test_invalid_json_raises_clear_error(monkeypatch):
    _recording_run(monkeypatch, stdout="not json")

    with pytest.raises(FizzyLiveClientError, match="Invalid JSON from fizzy board list --all"):
        _client().board_list()


def test_custom_timeout_threads_to_subprocess(monkeypatch):
    calls = _recording_run(monkeypatch, stdout='{"ok": true}')

    assert _client(timeout_seconds=7.5).doctor() == {"ok": True}

    assert calls[0]["timeout"] == 7.5


def test_timeout_raises_clear_client_error(monkeypatch):
    def fake_run(command, text, capture_output, check, timeout):
        raise subprocess.TimeoutExpired(command, timeout)

    monkeypatch.setattr(subprocess, "run", fake_run)

    with pytest.raises(
        FizzyLiveClientError,
        match="fizzy doctor --agent --quiet timed out after 30 seconds",
    ):
        _client().doctor()
