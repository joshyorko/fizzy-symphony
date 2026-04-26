from workai_smoke.cli import greeting


def test_greeting_includes_name():
    assert "Josh" in greeting("Josh")
