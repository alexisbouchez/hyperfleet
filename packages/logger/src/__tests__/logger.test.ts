import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { createLogger, generateCorrelationId, type Logger } from "../index";

describe("createLogger", () => {
  let mockConsole: {
    debug: ReturnType<typeof spyOn>;
    info: ReturnType<typeof spyOn>;
    warn: ReturnType<typeof spyOn>;
    error: ReturnType<typeof spyOn>;
  };

  beforeEach(() => {
    mockConsole = {
      debug: spyOn(console, "debug").mockImplementation(() => {}),
      info: spyOn(console, "info").mockImplementation(() => {}),
      warn: spyOn(console, "warn").mockImplementation(() => {}),
      error: spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    mockConsole.debug.mockRestore();
    mockConsole.info.mockRestore();
    mockConsole.warn.mockRestore();
    mockConsole.error.mockRestore();
  });

  it("creates logger with correlation ID", () => {
    const logger = createLogger({ correlationId: "test-123" });

    expect(logger).toBeDefined();
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  it("logs debug messages with correct format", () => {
    const logger = createLogger({ correlationId: "debug-test" });
    logger.debug("Test message");

    expect(mockConsole.debug).toHaveBeenCalledTimes(1);
    const logOutput = mockConsole.debug.mock.calls[0][0];
    const parsed = JSON.parse(logOutput);

    expect(parsed.level).toBe("debug");
    expect(parsed.correlationId).toBe("debug-test");
    expect(parsed.message).toBe("Test message");
    expect(parsed.timestamp).toBeDefined();
  });

  it("logs info messages with correct format", () => {
    const logger = createLogger({ correlationId: "info-test" });
    logger.info("Info message", { userId: 123 });

    expect(mockConsole.info).toHaveBeenCalledTimes(1);
    const logOutput = mockConsole.info.mock.calls[0][0];
    const parsed = JSON.parse(logOutput);

    expect(parsed.level).toBe("info");
    expect(parsed.correlationId).toBe("info-test");
    expect(parsed.message).toBe("Info message");
    expect(parsed.userId).toBe(123);
  });

  it("logs warn messages with correct format", () => {
    const logger = createLogger({ correlationId: "warn-test" });
    logger.warn("Warning message");

    expect(mockConsole.warn).toHaveBeenCalledTimes(1);
    const logOutput = mockConsole.warn.mock.calls[0][0];
    const parsed = JSON.parse(logOutput);

    expect(parsed.level).toBe("warn");
    expect(parsed.correlationId).toBe("warn-test");
    expect(parsed.message).toBe("Warning message");
  });

  it("logs error messages with correct format", () => {
    const logger = createLogger({ correlationId: "error-test" });
    logger.error("Error message", { error: "details" });

    expect(mockConsole.error).toHaveBeenCalledTimes(1);
    const logOutput = mockConsole.error.mock.calls[0][0];
    const parsed = JSON.parse(logOutput);

    expect(parsed.level).toBe("error");
    expect(parsed.correlationId).toBe("error-test");
    expect(parsed.message).toBe("Error message");
    expect(parsed.error).toBe("details");
  });

  it("includes additional context in log entries", () => {
    const logger = createLogger({
      correlationId: "context-test",
      service: "api",
      version: "1.0.0",
    });
    logger.info("Context test");

    const logOutput = mockConsole.info.mock.calls[0][0];
    const parsed = JSON.parse(logOutput);

    expect(parsed.correlationId).toBe("context-test");
    expect(parsed.service).toBe("api");
    expect(parsed.version).toBe("1.0.0");
  });

  describe("child logger", () => {
    it("creates child logger with merged context", () => {
      const parentLogger = createLogger({
        correlationId: "parent-123",
        service: "api",
      });
      const childLogger = parentLogger.child({ component: "auth" });

      childLogger.info("Child log");

      const logOutput = mockConsole.info.mock.calls[0][0];
      const parsed = JSON.parse(logOutput);

      expect(parsed.correlationId).toBe("parent-123");
      expect(parsed.service).toBe("api");
      expect(parsed.component).toBe("auth");
    });

    it("allows overriding parent context", () => {
      const parentLogger = createLogger({
        correlationId: "parent-456",
        request: "initial",
      });
      const childLogger = parentLogger.child({
        correlationId: "child-789",
        request: "updated",
      });

      childLogger.info("Override test");

      const logOutput = mockConsole.info.mock.calls[0][0];
      const parsed = JSON.parse(logOutput);

      expect(parsed.correlationId).toBe("child-789");
      expect(parsed.request).toBe("updated");
    });

    it("creates nested child loggers", () => {
      const level1 = createLogger({ correlationId: "req-1", level: 1 });
      const level2 = level1.child({ level: 2 });
      const level3 = level2.child({ level: 3 });

      level3.info("Nested");

      const logOutput = mockConsole.info.mock.calls[0][0];
      const parsed = JSON.parse(logOutput);

      expect(parsed.correlationId).toBe("req-1");
      expect(parsed.level).toBe(3);
    });
  });
});

describe("generateCorrelationId", () => {
  it("generates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateCorrelationId());
    }
    expect(ids.size).toBe(100);
  });

  it("generates IDs with correct prefix", () => {
    const id = generateCorrelationId();
    expect(id.startsWith("req_")).toBe(true);
  });

  it("generates IDs with expected format", () => {
    const id = generateCorrelationId();
    // Format: req_<timestamp>_<random>
    const parts = id.split("_");
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe("req");
    // Timestamp should be base36 encoded
    expect(parts[1].length).toBeGreaterThan(0);
    // Random part
    expect(parts[2].length).toBeGreaterThan(0);
  });
});
