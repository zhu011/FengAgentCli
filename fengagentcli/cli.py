"""Command-line interface for FengAgentCli."""

import argparse
import sys
from typing import List, Optional

from . import __version__
from .agent import AgentRunner
from .config import Config


def create_parser() -> argparse.ArgumentParser:
    """Build the argument parser for the CLI."""
    parser = argparse.ArgumentParser(
        prog="fengagentcli",
        description="A CLI tool for managing and running agents.",
    )
    parser.add_argument(
        "-V", "--version", action="version", version=f"fengagentcli {__version__}"
    )

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # add
    add_parser = subparsers.add_parser("add", help="Register a new agent")
    add_parser.add_argument("name", help="Agent name")
    add_parser.add_argument("path", help="Working directory path for the agent")
    add_parser.add_argument(
        "-t", "--task", default="", help="Task description for the agent"
    )

    # list
    subparsers.add_parser("list", help="List all registered agents")

    # remove
    rm_parser = subparsers.add_parser("remove", help="Remove a registered agent")
    rm_parser.add_argument("name", help="Agent name to remove")

    # run
    run_parser = subparsers.add_parser("run", help="Run a registered agent")
    run_parser.add_argument("name", help="Agent name to run")
    run_parser.add_argument(
        "-t", "--task", default=None, help="Override the agent's task for this run"
    )

    return parser


def cmd_add(args: argparse.Namespace, config: Config) -> int:
    """Handle the `add` subcommand."""
    config.add_agent(args.name, args.path, args.task)
    print(f"Agent '{args.name}' added (path: {args.path}).")
    return 0


def cmd_list(args: argparse.Namespace, config: Config) -> int:
    """Handle the `list` subcommand."""
    agents = config.list_agents()
    if not agents:
        print("No agents registered.")
        return 0
    print(f"{'Name':<20} {'Path':<40} {'Task'}")
    print("-" * 80)
    for name, info in agents.items():
        print(f"{name:<20} {info['path']:<40} {info.get('task', '')}")
    return 0


def cmd_remove(args: argparse.Namespace, config: Config) -> int:
    """Handle the `remove` subcommand."""
    if config.remove_agent(args.name):
        print(f"Agent '{args.name}' removed.")
        return 0
    print(f"Agent '{args.name}' not found.", file=sys.stderr)
    return 1


def cmd_run(args: argparse.Namespace, config: Config) -> int:
    """Handle the `run` subcommand."""
    agent_info = config.get_agent(args.name)
    if agent_info is None:
        print(f"Agent '{args.name}' not found.", file=sys.stderr)
        return 1
    task = args.task if args.task is not None else agent_info.get("task", "")
    runner = AgentRunner(agent_info["path"], task)
    return runner.run()


def main(argv: Optional[List[str]] = None) -> int:
    """CLI entry point."""
    parser = create_parser()
    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        return 0

    config = Config()

    dispatch = {
        "add": cmd_add,
        "list": cmd_list,
        "remove": cmd_remove,
        "run": cmd_run,
    }

    handler = dispatch.get(args.command)
    if handler is None:
        parser.print_help()
        return 1

    return handler(args, config)


if __name__ == "__main__":
    sys.exit(main())
