"""Tests for the AgentRunner class."""

from fengagentcli.agent import AgentRunner


def test_agent_runner_no_task(capsys) -> None:
    """Running with no task returns 0 and prints a message."""
    import os
    runner = AgentRunner(workdir=os.getcwd(), task="")
    assert runner.run() == 0
    captured = capsys.readouterr()
    assert "No task" in captured.out


def test_agent_runner_invalid_workdir(capsys) -> None:
    """Running with a non-existent directory returns 1."""
    runner = AgentRunner(workdir="/nonexistent/path/xyz", task="do something")
    assert runner.run() == 1
    captured = capsys.readouterr()
    assert "does not exist" in captured.err


def test_agent_runner_success(capsys, tmp_path) -> None:
    """Running with a valid directory and task succeeds."""
    runner = AgentRunner(workdir=str(tmp_path), task="build project")
    assert runner.run() == 0
    captured = capsys.readouterr()
    assert "build project" in captured.out
    assert "completed" in captured.out


def test_agent_runner_run_command(tmp_path) -> None:
    """run_command executes a shell command in the workdir."""
    runner = AgentRunner(workdir=str(tmp_path), task="")
    code = runner.run_command("echo hello")
    assert code == 0


def test_agent_runner_run_command_invalid_dir(capsys) -> None:
    """run_command returns None for an invalid workdir."""
    runner = AgentRunner(workdir="/nonexistent/path/xyz", task="")
    assert runner.run_command("echo hello") is None
