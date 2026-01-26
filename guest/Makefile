# Hyperfleet Init System Makefile
# Builds static init binaries for x86_64 and aarch64

.PHONY: all clean build-amd64 build-arm64 install

CC ?= gcc
CFLAGS = -static -O2 -Wall -Wextra -Werror -std=c11 -D_GNU_SOURCE
LDFLAGS = -static -pthread

OUTPUT_DIR := ../assets/init
SRC := init.c

all: build-amd64

$(OUTPUT_DIR):
	mkdir -p $(OUTPUT_DIR)

# Native build (for local development)
build: $(OUTPUT_DIR)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $(OUTPUT_DIR)/init $(SRC)

# Cross-compile for x86_64 (requires musl-cross or appropriate toolchain)
build-amd64: $(OUTPUT_DIR)
	@if command -v x86_64-linux-musl-gcc >/dev/null 2>&1; then \
		x86_64-linux-musl-gcc $(CFLAGS) $(LDFLAGS) -o $(OUTPUT_DIR)/init-amd64 $(SRC); \
	elif command -v musl-gcc >/dev/null 2>&1; then \
		musl-gcc $(CFLAGS) $(LDFLAGS) -o $(OUTPUT_DIR)/init-amd64 $(SRC); \
	else \
		echo "Warning: musl toolchain not found, using default gcc"; \
		$(CC) $(CFLAGS) $(LDFLAGS) -o $(OUTPUT_DIR)/init-amd64 $(SRC); \
	fi

# Cross-compile for aarch64 (requires cross-compiler)
build-arm64: $(OUTPUT_DIR)
	@if command -v aarch64-linux-musl-gcc >/dev/null 2>&1; then \
		aarch64-linux-musl-gcc $(CFLAGS) $(LDFLAGS) -o $(OUTPUT_DIR)/init-arm64 $(SRC); \
	elif command -v aarch64-linux-gnu-gcc >/dev/null 2>&1; then \
		aarch64-linux-gnu-gcc $(CFLAGS) $(LDFLAGS) -o $(OUTPUT_DIR)/init-arm64 $(SRC); \
	else \
		echo "Warning: aarch64 cross-compiler not found, skipping arm64 build"; \
	fi

clean:
	rm -f $(OUTPUT_DIR)/init $(OUTPUT_DIR)/init-amd64 $(OUTPUT_DIR)/init-arm64

# Install to a rootfs (for development)
# Usage: make install ROOTFS=/path/to/rootfs
install: build-amd64
	@if [ -z "$(ROOTFS)" ]; then \
		echo "Usage: make install ROOTFS=/path/to/rootfs"; \
		exit 1; \
	fi
	sudo cp $(OUTPUT_DIR)/init-amd64 $(ROOTFS)/init
	sudo chmod 755 $(ROOTFS)/init

# Run basic checks
check:
	@echo "Checking for required tools..."
	@which gcc || echo "gcc not found"
	@which musl-gcc || echo "musl-gcc not found (optional)"
	@which x86_64-linux-musl-gcc || echo "x86_64-linux-musl-gcc not found (optional)"
	@which aarch64-linux-musl-gcc || echo "aarch64-linux-musl-gcc not found (optional)"
