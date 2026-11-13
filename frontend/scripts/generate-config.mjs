#!/usr/bin/env node
// Genera frontend/public/config.js a partir de frontend/config.example.js.
// El despliegue fuerza apiBaseUrl: "" para usar el mismo origen (CloudFront
// enruta /api/* al ALB). El archivo generado está ignorado por git.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "..", "config.example.js");
const publicDir = join(here, "..", "public");
const outputPath = join(publicDir, "config.js");

const source = readFileSync(sourcePath, "utf8");
const output = source.replace(
  /(apiBaseUrl\s*:\s*)(?:"[^"]*"|'[^']*'|`[^`]*`)/,
  '$1""'
);

if (!/apiBaseUrl\s*:\s*""/.test(output)) {
  throw new Error(
    "config.example.js debe declarar apiBaseUrl con un valor entre comillas."
  );
}

mkdirSync(publicDir, { recursive: true });
writeFileSync(outputPath, output.endsWith("\n") ? output : `${output}\n`);
console.log(`config: generado ${outputPath} con apiBaseUrl: ""`);
