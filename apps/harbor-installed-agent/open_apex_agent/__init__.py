"""Open-Apex Harbor installed-agent wrapper.

§3.4.7 defines the contract: a thin Python class that Harbor can import via
``harbor run --agent-import-path open_apex_agent:OpenApexAgent``.

Harbor's BaseInstalledAgent requires:
  - ``install(self, environment)`` — install the agent binary before the
    agent-timeout clock starts (Harbor setup phase).
  - ``setup(self, environment)`` — pre-run environment setup (default impl
    calls install()).
  - ``run(self, instruction, environment, context)`` — invoke the agent
    binary. Decorated with ``@with_prompt_template`` so preset appendices
    can be overridden via ``--agent-kwarg``.
  - ``populate_context_post_run(self, context)`` — parse artifacts, sum
    metrics into context.n_input_tokens / n_output_tokens / n_cache_tokens /
    cost_usd, set rollout_details for RL training.
  - ``SUPPORTS_ATIF = True`` — tells Harbor to look for trajectory.json.

M0 scope: a working Python class with real ``install()`` logic that the
user can test by running ``uv run python -m open_apex_agent.install_probe``
in isolation. The actual live ``run()`` wiring through Harbor happens in M6.
"""

from __future__ import annotations

__version__ = "0.0.1"

# Import happens lazily so test-only environments that install this package
# without Harbor don't break at import time.
try:
    from .agent import OpenApexAgent  # noqa: F401
except ImportError:
    # Harbor may not be importable in isolated test environments. The
    # OpenApexAgent class requires harbor at runtime; skip gracefully here.
    pass
