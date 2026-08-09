"""Configuration management for FengAgentCli."""

import json
from pathlib import Path
from typing import Any, Dict, Optional


DEFAULT_CONFIG_DIR = Path.home() / ".fengagentcli"
DEFAULT_CONFIG_FILE = DEFAULT_CONFIG_DIR / "config.json"


class Config:
    """Manages agent configuration stored as JSON."""

    def __init__(self, config_path: Optional[Path] = None) -> None:
        self.config_path = Path(config_path) if config_path else DEFAULT_CONFIG_FILE
        self._data: Dict[str, Any] = {}
        self.load()

    def load(self) -> None:
        """Load configuration from disk."""
        if self.config_path.exists():
            with open(self.config_path, "r", encoding="utf-8") as f:
                self._data = json.load(f)
        else:
            self._data = {"agents": {}}

    def save(self) -> None:
        """Persist configuration to disk."""
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.config_path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, indent=2, ensure_ascii=False)

    def add_agent(self, name: str, path: str, task: str = "") -> None:
        """Register a new agent in the configuration."""
        self._data.setdefault("agents", {})[name] = {
            "path": path,
            "task": task,
        }
        self.save()

    def get_agent(self, name: str) -> Optional[Dict[str, Any]]:
        """Retrieve an agent by name."""
        return self._data.get("agents", {}).get(name)

    def list_agents(self) -> Dict[str, Any]:
        """Return all registered agents."""
        return self._data.get("agents", {})

    def remove_agent(self, name: str) -> bool:
        """Remove an agent from configuration. Returns True if found."""
        agents = self._data.get("agents", {})
        if name in agents:
            del agents[name]
            self.save()
            return True
        return False

    def as_dict(self) -> Dict[str, Any]:
        """Return the raw configuration dictionary."""
        return self._data
