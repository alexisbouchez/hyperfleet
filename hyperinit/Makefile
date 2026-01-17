# Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
# Licensed under the AGPL-3.0 License. See LICENSE file for details.

CC = gcc
CFLAGS = -Wall -Wextra -O2 -static -D_GNU_SOURCE
LDFLAGS = -static

# For musl-based builds (e.g., Alpine)
ifdef MUSL
CC = musl-gcc
endif

TARGET = hyperinit
SRCS = src/main.c src/http.c src/exec.c src/files.c src/json.c
OBJS = $(SRCS:.c=.o)

.PHONY: all clean

all: $(TARGET)

$(TARGET): $(OBJS)
	$(CC) $(LDFLAGS) -o $@ $^

%.o: %.c
	$(CC) $(CFLAGS) -c -o $@ $<

clean:
	rm -f $(TARGET) $(OBJS)

# Dependencies
src/main.o: src/main.c src/http.h src/exec.h src/files.h
src/http.o: src/http.c src/http.h src/json.h
src/exec.o: src/exec.c src/exec.h src/json.h
src/files.o: src/files.c src/files.h src/json.h
src/json.o: src/json.c src/json.h
