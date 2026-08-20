#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const validationMode = process.argv.includes("--validation");
const callMarker = process.env.ARK_MCP_CALL_MARKER || "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolDefinition() {
  if (validationMode) {
    return {
      name: "fixture_fail",
      description: "Validation fixture tool",
      inputSchema: {
        type: "object",
        properties: { required_integer: { type: "integer" } },
        required: ["required_integer"],
        additionalProperties: false,
      },
    };
  }
  return {
    name: "fixture_fail",
    description: "Always returns the fixed fixture MCP error",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  };
}

function handle(message) {
  if (!message || typeof message !== "object") return;
  if (message.method === "notifications/initialized") return;
  if (!("id" in message)) return;

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "ark-loop-fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [toolDefinition()] } });
    return;
  }
  if (message.method === "tools/call") {
    if (callMarker) fs.appendFileSync(callMarker, "tools/call\n", { encoding: "utf8" });
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: "fixture MCP error" }],
        isError: true,
      },
    });
    return;
  }
  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Method not found" },
  });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  try {
    handle(JSON.parse(line));
  } catch {
    // Test fixture server deliberately ignores malformed transport input.
  }
});
