//! Rust module in the mixed-monorepo fixture.

pub struct Pipeline {
    pub name: String,
}

pub trait Stage {
    fn run(&self, input: i64) -> i64;
}

impl Stage for Pipeline {
    fn run(&self, input: i64) -> i64 {
        input * 2
    }
}

pub fn compute_total(values: &[i64]) -> i64 {
    values.iter().sum()
}
