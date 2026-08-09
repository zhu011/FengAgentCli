"""Tests for the Config class."""

import json
from pathlib import Path

from fengagentcli.config import Config


def test_config_load_defaults(tmp_path: Path) -> None:
    """Config without an existing file starts with empty agents."""
    config = Config(config_path=tmp_path / "config.json")
    assert config.list_agents() == {}


def test_config_add_and_get(tmp_path: Path) -> None:
    """Adding an agent persists and retrieves it."""
    config_path = tmp_path / "config.json"
    config = Config(config_path=config_path)
    config.add_agent("my-agent", "/tmp/work", task="do something")

    assert config.get_agent("my-agent") == {
        "path": "/tmp/work",
        "task": "do something",
    }

    # Reload from disk to verify persistence
    config2 = Config(config_path=config_path)
    assert config2.get_agent("my-agent")["path"] == "/tmp/work"


def test_config_remove(tmp_path: Path) -> None:
    """Removing an agent deletes it and returns True; missing returns False."""
    config = Config(config_path=tmp_path / "config.json")
    config.add_agent("to-remove", "/tmp/work")
    assert config.remove_agent("to-remove") is True
    assert config.get_agent("to-remove") is None
    assert config.remove_agent("nonexistent") is False


def test_config_list_agents(tmp_path: Path) -> None:
    """list_agents returns all registered agents."""
    config = Config(config_path=tmp_path / "config.json")
    config.add_agent("a1", "/path1")
    config.add_agent("a2", "/path2")
    agents = config.list_agents()
    assert set(agents.keys()) == {"a1", "a2"}


def test_config_save_creates_directory(tmp_path: Path) -> None:
    """save() creates parent directories as needed."""
    config_path = tmp_path / "subdir" / "config.json"
    config = Config(config_path=config_path)
    config.add_agent("agent-x", "/work")
    assert config_path.exists()
    data = json.loads(config_path.read_text(encoding="utf-8"))
    assert "agent-x" in data["agents"]
