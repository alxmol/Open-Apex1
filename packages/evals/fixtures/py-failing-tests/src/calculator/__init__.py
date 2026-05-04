"""Calculator module.

This file contains a SEEDED BUG per the fixture's expected.json:
`divide` raises ArithmeticError instead of the expected ZeroDivisionError.
The agent should fix this by raising ZeroDivisionError.
"""


def add(a: float, b: float) -> float:
    return a + b


def subtract(a: float, b: float) -> float:
    return a - b


def multiply(a: float, b: float) -> float:
    return a * b


def divide(a: float, b: float) -> float:
    if b == 0:
        # SEEDED BUG — should raise ZeroDivisionError to match tests.
        raise ArithmeticError("cannot divide by zero")
    return a / b
