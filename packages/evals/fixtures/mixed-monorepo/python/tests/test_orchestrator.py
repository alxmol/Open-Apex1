from src.orchestrator import Orchestrator, compute_total


def test_compute_total() -> None:
    assert compute_total([1, 2, 3]) == 6


def test_orchestrator_runs() -> None:
    assert Orchestrator().run([4, 5]) == 9
