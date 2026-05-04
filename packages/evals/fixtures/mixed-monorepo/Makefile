.PHONY: all test

all: test

test:
	cd python && pytest
	cd rust && cargo test
	cd go && go test ./...
	cd ts && tsc --noEmit
