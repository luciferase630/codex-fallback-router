const VERSION = "0.1.0";

const command = process.argv[2] ?? "help";

if (command === "--version" || command === "version") {
  console.log(VERSION);
} else {
  console.log(`codex-fallback ${VERSION}\n\nCommands:\n  install\n  config set\n  start\n  stop\n  status\n  smoke-test\n  uninstall`);
}

