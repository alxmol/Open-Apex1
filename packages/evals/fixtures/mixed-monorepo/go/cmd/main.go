package main

import "fmt"

type Scheduler struct {
	Concurrency int
}

func (s *Scheduler) Run(values []int) int {
	total := 0
	for _, v := range values {
		total += v
	}
	return total
}

func ComputeTotal(values []int) int {
	s := &Scheduler{Concurrency: 1}
	return s.Run(values)
}

func main() {
	fmt.Println(ComputeTotal([]int{1, 2, 3}))
}
