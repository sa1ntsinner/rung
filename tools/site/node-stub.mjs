// SPDX-License-Identifier: MIT
// Stand-ins for the Node.js modules rung's language server and test runner import, in the browser build of the
// playground. Only paths are ever computed there; reading files is never reached.
const none = () => {
  throw new Error("no file system in the browser");
};
export const readFile = none;
export const readdir = none;
export const writeFile = none;
export const mkdir = none;
export const watch = none;
export const sep = "/";
export const delimiter = ":";
export const join = (...parts) => parts.filter(Boolean).join("/").replace(/\/+/g, "/");
export const resolve = join;
export const relative = (from, to) => (to.startsWith(from + "/") ? to.slice(from.length + 1) : to);
export const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";
export const pathToFileURL = (p) => new URL("file://" + (p.startsWith("/") ? "" : "/") + p);
export const fileURLToPath = (u) => decodeURIComponent(new URL(String(u)).pathname);
export default { readFile, readdir, writeFile, mkdir, watch, sep, delimiter, join, resolve, relative, dirname, pathToFileURL, fileURLToPath };
