#!/usr/bin/env node
"use strict";

/**
 * Theme validator, sharing the exact checks the server applies.
 *
 * `lib/theme-manifest.ts` is loaded through Node's type stripping (the project
 * requires Node 22.19+, where that flag exists), so a theme cannot pass the CLI
 * and then be rejected by the app — or the other way round.
 *
 *   pi-web-theme check ./my-theme
 *   pi-web-theme check ./my-theme --json
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pathToFileURL } = require("url");

const USAGE = `Usage: pi-web-theme check [directory] [--json]

Validates a Pi Web theme (theme.json + theme.css) before you install it.

Options:
  --json        Print the report as JSON
  -h, --help    Show this help

The same validation runs on the server when a theme is applied, so a theme that
passes here will be accepted there too.`;

function parseArgs(argv) {
  const options = { command: null, directory: ".", json: false, help: false };
  for (const argument of argv) {
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "--json") options.json = true;
    else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else if (!options.command) options.command = argument;
    else options.directory = argument;
  }
  return options;
}

async function loadValidator() {
  const manifestUrl = pathToFileURL(path.join(__dirname, "..", "lib", "theme-manifest.ts")).href;
  return import(manifestUrl);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (options.command !== "check") {
    process.stderr.write(`${options.command ? `Unknown command: ${options.command}\n` : ""}${USAGE}\n`);
    return 1;
  }

  const directory = path.resolve(options.directory);
  const manifestPath = path.join(directory, "theme.json");
  if (!fs.existsSync(manifestPath)) {
    process.stderr.write(`No theme.json in ${directory}\n`);
    return 1;
  }

  const validator = await loadValidator();
  const issues = [];
  let manifest = null;

  try {
    const parsed = validator.parseThemeManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    manifest = parsed.manifest;
    issues.push(...parsed.issues);
  } catch (error) {
    issues.push({ level: "error", message: `theme.json is not valid JSON: ${error.message}` });
  }

  const overridden = new Set();
  const checkStylesheet = (file) => {
    const stylePath = path.join(directory, file);
    if (!fs.existsSync(stylePath)) {
      issues.push({ level: "error", message: `Missing stylesheet: ${file}` });
      return;
    }
    const css = fs.readFileSync(stylePath, "utf8");
    const validation = validator.validateThemeCss(css, { manifest });
    for (const variable of validation.overriddenVariables) overridden.add(variable);
    issues.push(...validation.issues, ...validator.checkThemeContrast(css));
  };

  checkStylesheet(manifest?.styles?.[0] ?? "theme.css");
  // Declared variant stylesheets are part of the theme; the server validates them
  // too, so a theme must not pass here while failing at apply time.
  for (const [mode, file] of Object.entries(manifest?.variants ?? {})) {
    checkStylesheet(file);
    if (!fs.existsSync(path.join(directory, file))) {
      issues.push({ level: "error", message: `Variant "${mode}" could not be read.` });
    }
  }
  const overriddenVariables = [...overridden];

  // Same rule as the server: a base stylesheet that only carries shared rules is
  // fine when a variant defines the palette.
  const relevant = overriddenVariables.length > 0
    ? issues.filter((issue) => issue.code !== "no-variables")
    : issues;
  const errors = relevant.filter((issue) => issue.level === "error");
  const warnings = relevant.filter((issue) => issue.level === "warning");

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ok: errors.length === 0,
      directory,
      manifest,
      overriddenVariables,
      errors,
      warnings,
    }, null, 2)}\n`);
    return errors.length === 0 ? 0 : 1;
  }

  const name = manifest ? `${manifest.name} (${manifest.id}) v${manifest.version}` : "unknown theme";
  process.stdout.write(`${name} — ${directory}\n`);
  process.stdout.write(`Overrides ${overriddenVariables.length} theme variable(s).\n`);
  if (errors.length === 0 && warnings.length === 0) {
    process.stdout.write("No problems found.\n");
  }
  for (const issue of errors) process.stdout.write(`  error: ${issue.message}\n`);
  for (const issue of warnings) process.stdout.write(`  warning: ${issue.message}\n`);
  process.stdout.write(errors.length === 0
    ? `${warnings.length} warning(s).\n`
    : `${errors.length} error(s), ${warnings.length} warning(s).\n`);
  return errors.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
