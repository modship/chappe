#!/usr/bin/env node
// Sets the app version everywhere it lives: package.json, package-lock.json,
// src-tauri/tauri.conf.json, src-tauri/Cargo.toml and src-tauri/Cargo.lock.
// The release workflow refuses a tag that doesn't match all of them.
//
//   npm run version:set 0.3.0

import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
  console.error("usage: npm run version:set <x.y.z>");
  process.exit(1);
}

/** Rewrites a file; `fn` throws when it can't find the version. */
const edit = (path, fn) => {
  const before = readFileSync(path, "utf8");
  const after = fn(before);
  if (after !== before) writeFileSync(path, after);
  console.log(`  ${path}${after === before ? " (already set)" : ""}`);
};

/** Replaces the first match of `pattern`, whose groups 1 and 2 surround the version. */
const replace = (path, pattern) => (text) => {
  if (!pattern.test(text)) throw new Error(`${path}: version field not found`);
  return text.replace(pattern, `$1${version}$2`);
};

/** JSON files keep npm's layout: two spaces and a final newline. */
const json = (path, fn) => (text) => {
  const data = JSON.parse(text);
  fn(data);
  return `${JSON.stringify(data, null, 2)}\n`;
};

edit(
  "package.json",
  json("package.json", (p) => {
    p.version = version;
  }),
);
edit(
  "package-lock.json",
  json("package-lock.json", (lock) => {
    lock.version = version;
    if (!lock.packages?.[""]) throw new Error("package-lock.json: root package not found");
    lock.packages[""].version = version;
  }),
);
edit(
  "src-tauri/tauri.conf.json",
  json("src-tauri/tauri.conf.json", (conf) => {
    if (!("version" in conf)) throw new Error("src-tauri/tauri.conf.json: version field not found");
    conf.version = version;
  }),
);
edit("src-tauri/Cargo.toml", replace("src-tauri/Cargo.toml", /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/));
edit("src-tauri/Cargo.lock", replace("src-tauri/Cargo.lock", /(\nname = "chappe"\nversion = ")[^"]+(")/));

console.log(`
Version set to ${version}. Next:
  git commit -am "Release v${version}" && git tag v${version} && git push && git push --tags`);
