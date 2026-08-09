"""Agent runner — executes agent tasks in a working directory."""

import os
import subprocess
import sys
from typing import Optional


class AgentRunner:
    """Runs an agent task within a given working directory."""

    def __init__(self, workdir: str, task: str = "") -> None:
        self.workdir = workdir
        self.task = task

    def _validate_workdir(self) -> bool:
        """Check that the working directory exists."""
        return os.path.isdir(self.workdir)

    def run(self) -> int:
        """Execute the agent task.

        Prints the task and working directory, then simulates execution.
        Returns 0 on success, 1 on failure.
        """
        if not self._validate_workdir():
            print(
                f"Error: working directory does not exist: {self.workdir}",
                file=sys.stderr,
            )
            return 1

        if not self.task:
            print("No task specified. Nothing to run.")
            return 0

        print(f"[AgentRunner] workdir: {self.workdir}")
        print(f"[AgentRunner] task: {self.task}")
        print("[AgentRunner] task completed.")
        return 0

    def run_command(self, command: str) -> Optional[int]:
        """Run a shell command inside the working directory.

        Returns the command's exit code, or None if the workdir is invalid.
        """
        if not self._validate_workdir():
            print(
                f"Error: working directory does not exist: {self.workdir}",
                file=sys.stderr,
            )
            return None
        result = subprocess.run(
            command,
            shell=True,
            cwd=self.workdir,
            capture_output=True,
            text=True,
        )
        if result.stdout:
            print(result.stdout, end="")
        if result.stderr:
            print(result.stderr, end="", file=sys.stderr)
        return result.returncode
