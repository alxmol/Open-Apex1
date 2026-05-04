"""Seeded library for the recovery-malformed-patch fixture.

The whitespace + wording is intentionally awkward so that a naive
patch attempt against the documented-task description will produce a
context mismatch, exercising the \u00a71.2 patch-recovery flow.
"""


def greet(name):
    # Seeded: return the wrong greeting; a task agent must change this.
    return "Hi  " + name
