"""Tests for calculator. The divide_by_zero test exposes the seeded bug."""

import pytest

from calculator import add, divide, multiply, subtract


def test_add() -> None:
    assert add(2, 3) == 5


def test_subtract() -> None:
    assert subtract(5, 3) == 2


def test_multiply() -> None:
    assert multiply(4, 3) == 12


def test_divide() -> None:
    assert divide(10, 2) == 5


def test_divide_by_zero() -> None:
    """Expects ZeroDivisionError, but the current impl raises ArithmeticError."""
    with pytest.raises(ZeroDivisionError):
        divide(1, 0)
