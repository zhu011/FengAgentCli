# FengAgentCli

A CLI tool for managing and running agents.

## Installation

```bash
pip install -e .
```

## Usage

```bash
# Register a new agent
fengagentcli add my-agent /path/to/workdir -t "Build the project"

# List all registered agents
fengagentcli list

# Run a registered agent
fengagentcli run my-agent

# Remove a registered agent
fengagentcli remove my-agent

# Show version
fengagentcli --version
```

You can also run it as a module:

```bash
python -m fengagentcli --help
```

## Development

```bash
# Install in development mode
pip install -e .

# Run tests
pytest
```

## License

MIT
