// SPDX-License-Identifier: MIT
// Mocha entry point inside the Extension Development Host: runs <suite>.test.js (RUNG_E2E_SUITE).
import { join } from "node:path";
import Mocha from "mocha";

export function run(): Promise<void> {
  const suite = process.env.RUNG_E2E_SUITE ?? "fake";
  const mocha = new Mocha({ ui: "bdd", timeout: 120_000, color: false, ...(process.env.RUNG_E2E_GREP ? { grep: process.env.RUNG_E2E_GREP } : {}) });
  mocha.addFile(join(__dirname, `${suite}.test.js`));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
}
