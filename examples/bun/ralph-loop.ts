// Copyright (c) 2025 Alexis Bouchez <alexbcz@proton.me>
// Licensed under the AGPL-3.0 License. See LICENSE file for details.

/**
 * Ralph Loop Example
 *
 * Demonstrates the Ralph Loop pattern where an AI agent runs autonomously
 * in a Hyperfleet sandbox, working through a TODO list.
 *
 * This example simulates the pattern by:
 * 1. Creating a machine with a TODO.txt file
 * 2. Running a loop that reads TODO.txt, processes tasks, and updates it
 * 3. Using "back pressure" (tests) to verify work
 */

import { HyperfleetClient } from "./hyperfleet";

const client = new HyperfleetClient();

// Initial TODO list
const initialTodo = `# TODO List for Calculator App

- [ ] Create the calculator module
- [ ] Add unit tests for calculator
- [ ] Run tests and verify they pass
- [ ] Create a simple CLI interface
`;

// Calculator module to be "written" by the agent
const calculatorCode = `
// calculator.ts - A simple calculator module

export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function divide(a: number, b: number): number {
  if (b === 0) {
    throw new Error("Division by zero");
  }
  return a / b;
}
`;

// Tests for the calculator
const calculatorTests = `
// calculator.test.ts - Unit tests for calculator

import { expect, test, describe } from "bun:test";
import { add, subtract, multiply, divide } from "./calculator";

describe("Calculator", () => {
  test("add", () => {
    expect(add(2, 3)).toBe(5);
    expect(add(-1, 1)).toBe(0);
    expect(add(0, 0)).toBe(0);
  });

  test("subtract", () => {
    expect(subtract(5, 3)).toBe(2);
    expect(subtract(1, 1)).toBe(0);
    expect(subtract(0, 5)).toBe(-5);
  });

  test("multiply", () => {
    expect(multiply(3, 4)).toBe(12);
    expect(multiply(0, 5)).toBe(0);
    expect(multiply(-2, 3)).toBe(-6);
  });

  test("divide", () => {
    expect(divide(10, 2)).toBe(5);
    expect(divide(7, 2)).toBe(3.5);
    expect(() => divide(5, 0)).toThrow("Division by zero");
  });
});
`;

// CLI interface
const cliCode = `
// cli.ts - Simple CLI for calculator

import { add, subtract, multiply, divide } from "./calculator";

const args = process.argv.slice(2);

if (args.length !== 3) {
  console.log("Usage: bun run cli.ts <operation> <a> <b>");
  console.log("Operations: add, subtract, multiply, divide");
  process.exit(1);
}

const [op, a, b] = args;
const numA = parseFloat(a);
const numB = parseFloat(b);

if (isNaN(numA) || isNaN(numB)) {
  console.error("Error: a and b must be numbers");
  process.exit(1);
}

let result: number;
switch (op) {
  case "add":
    result = add(numA, numB);
    break;
  case "subtract":
    result = subtract(numA, numB);
    break;
  case "multiply":
    result = multiply(numA, numB);
    break;
  case "divide":
    result = divide(numA, numB);
    break;
  default:
    console.error(\`Unknown operation: \${op}\`);
    process.exit(1);
}

console.log(\`\${numA} \${op} \${numB} = \${result}\`);
`;

async function main() {
  console.log("🔄 Ralph Loop Example\n");
  console.log("This simulates an AI agent working through a TODO list.\n");

  // Create the machine
  console.log("📦 Creating sandbox machine...");
  const machine = await client.createMachine({
    vcpu_count: 2,
    memory_mb: 1024,
    env: {
      TASK: "implement-calculator",
    },
  });
  console.log(`   Machine: ${machine.id}\n`);

  try {
    // Start the machine
    console.log("▶️  Starting machine...");
    await client.startMachine(machine.id);
    await client.waitForStatus(machine.id, "running");
    console.log("   Machine is running!\n");

    // Create workspace
    await client.mkdir(machine.id, "/workspace");

    // Write initial TODO
    console.log("📝 Writing initial TODO.txt...");
    await client.writeFile(machine.id, "/workspace/TODO.txt", initialTodo);

    // Simulate Ralph Loop iterations
    for (let iteration = 1; iteration <= 4; iteration++) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`📋 Iteration ${iteration}: Reading TODO.txt...`);
      console.log("=".repeat(60));

      const todoContent = new TextDecoder().decode(
        await client.readFile(machine.id, "/workspace/TODO.txt")
      );
      console.log(todoContent);

      // Find the first uncompleted task
      const lines = todoContent.split("\n");
      const taskIndex = lines.findIndex((line) => line.includes("- [ ]"));

      if (taskIndex === -1) {
        console.log("✅ All tasks completed!");
        break;
      }

      const task = lines[taskIndex];
      console.log(`\n🔨 Working on: ${task.trim()}`);

      // Process the task based on what it is
      if (task.includes("Create the calculator module")) {
        console.log("   Writing calculator.ts...");
        await client.writeFile(machine.id, "/workspace/calculator.ts", calculatorCode);

        // Verify it was written
        const result = await client.exec(machine.id, ["ls", "-la", "/workspace/"]);
        console.log("   Files:", result.stdout.split("\n").filter(l => l.includes("calculator")).join(", "));

      } else if (task.includes("Add unit tests")) {
        console.log("   Writing calculator.test.ts...");
        await client.writeFile(machine.id, "/workspace/calculator.test.ts", calculatorTests);

      } else if (task.includes("Run tests")) {
        console.log("   Running tests (back pressure)...");
        const testResult = await client.exec(machine.id, [
          "bun",
          "test",
          "/workspace/calculator.test.ts",
        ], { timeout: 60 });

        console.log("\n   Test output:");
        console.log(testResult.stdout || testResult.stderr);

        if (testResult.exit_code !== 0) {
          console.log("   ❌ Tests failed! Would need to fix issues...");
        } else {
          console.log("   ✅ All tests passed!");
        }

      } else if (task.includes("Create a simple CLI")) {
        console.log("   Writing cli.ts...");
        await client.writeFile(machine.id, "/workspace/cli.ts", cliCode);

        // Test the CLI
        console.log("   Testing CLI...");
        const cliResult = await client.exec(machine.id, [
          "bun",
          "run",
          "/workspace/cli.ts",
          "add",
          "5",
          "3",
        ]);
        console.log(`   CLI output: ${cliResult.stdout.trim()}`);
      }

      // Mark task as complete and update TODO
      lines[taskIndex] = lines[taskIndex].replace("- [ ]", "- [x]");
      const updatedTodo = lines.join("\n");
      await client.writeFile(machine.id, "/workspace/TODO.txt", updatedTodo);
      console.log("   ✓ Task marked as complete");

      // Small delay between iterations
      await Bun.sleep(500);
    }

    // Show final state
    console.log(`\n${"=".repeat(60)}`);
    console.log("📋 Final TODO.txt:");
    console.log("=".repeat(60));
    const finalTodo = new TextDecoder().decode(
      await client.readFile(machine.id, "/workspace/TODO.txt")
    );
    console.log(finalTodo);

    console.log("\n📂 Final workspace contents:");
    const files = await client.listFiles(machine.id, "/workspace");
    for (const file of files) {
      console.log(`   - ${file}`);
    }

  } finally {
    // Cleanup
    console.log("\n🧹 Cleaning up...");
    try {
      await client.stopMachine(machine.id);
      await client.waitForStatus(machine.id, "stopped");
    } catch {
      // Ignore
    }
    await client.deleteMachine(machine.id);
    console.log("   Machine deleted");
  }

  console.log("\n✅ Ralph Loop example completed!");
}

main().catch(console.error);
