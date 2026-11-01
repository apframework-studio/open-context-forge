#!/usr/bin/env node
import { writeFileSync } from "node:fs";

writeFileSync(process.env.OCF_TEST_PID_FILE ?? process.argv[2], String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 1500);
