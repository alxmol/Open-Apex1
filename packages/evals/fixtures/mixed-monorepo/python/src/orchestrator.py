"""Python-side orchestrator. Defines a trivial class + function pair for the
symbol-index integration test to find."""


def compute_total(values: list[int]) -> int:
    return sum(values)


class Orchestrator:
    def __init__(self, strategy: str = "greedy") -> None:
        self.strategy = strategy

    def run(self, workload: list[int]) -> int:
        return compute_total(workload)
