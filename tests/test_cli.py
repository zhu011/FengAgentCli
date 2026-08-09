"""Tests for the CLI module."""

from fengagentcli.cli import main


def test_cli_no_command_prints_help(capsys) -> None:
    """Calling with no subcommand prints help and returns 0."""
    assert main([]) == 0
    captured = capsys.readouterr()
    assert "usage" in captured.out.lower()


def test_cli_version(capsys) -> None:
    """--version prints the version string."""
    try:
        main(["--version"])
    except SystemExit as e:
        assert e.code == 0
    captured = capsys.readouterr()
    assert "fengagentcli" in captured.out


def test_cli_add_and_list(tmp_path, capsys, monkeypatch) -> None:
    """add then list shows the registered agent."""
    config_path = tmp_path / "config.json"
    monkeypatch.setattr("fengagentcli.config.DEFAULT_CONFIG_FILE", config_path)

    ret = main(["add", "test-agent", "/tmp/work", "-t", "my task"])
    assert ret == 0

    ret = main(["list"])
    assert ret == 0
    captured = capsys.readouterr()
    assert "test-agent" in captured.out


def test_cli_remove(tmp_path, capsys, monkeypatch) -> None:
    """remove deletes a previously added agent."""
    config_path = tmp_path / "config.json"
    monkeypatch.setattr("fengagentcli.config.DEFAULT_CONFIG_FILE", config_path)

    main(["add", "removable", "/tmp/work"])
    ret = main(["remove", "removable"])
    assert ret == 0


def test_cli_remove_not_found(tmp_path, capsys, monkeypatch) -> None:
    """remove on a missing agent returns 1."""
    config_path = tmp_path / "config.json"
    monkeypatch.setattr("fengagentcli.config.DEFAULT_CONFIG_FILE", config_path)

    ret = main(["remove", "nope"])
    assert ret == 1


def test_cli_run_not_found(tmp_path, capsys, monkeypatch) -> None:
    """run on a missing agent returns 1."""
    config_path = tmp_path / "config.json"
    monkeypatch.setattr("fengagentcli.config.DEFAULT_CONFIG_FILE", config_path)

    ret = main(["run", "ghost"])
    assert ret == 1
