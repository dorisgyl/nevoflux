#!/usr/bin/env node

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Copy WASM build outputs to the extension's wasm/ directory
 *
 * This script copies the Trunk build outputs from dioxus-ui/dist/
 * to the extension's wasm/ directory where they can be loaded.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const BUILDS = [
  {
    name: 'chat-sidebar',
    src: path.join(ROOT, 'dioxus-ui', 'dist', 'chat-sidebar'),
    dest: path.join(ROOT, 'wasm', 'chat-sidebar'),
    // Hand-maintained files that live in wasm/chat-sidebar/ *outside* the trunk
    // pipeline (see the comments in dioxus-ui/chat-sidebar/index.html). The dest
    // is wiped below to drop stale hashed bundles, and trunk never emits these,
    // so without carrying them across the wipe every WASM rebuild silently
    // deletes them — which breaks the minimize/maximize/Schedule-Jobs buttons
    // and the Space theme-follow.
    preserve: ['sidebar-boot.js', 'nf-theme.css', 'theme-color.mjs'],
  },
  {
    name: 'content-sidebar',
    src: path.join(ROOT, 'dioxus-ui', 'dist', 'content-sidebar'),
    dest: path.join(ROOT, 'wasm', 'content-sidebar'),
    preserve: [],
  },
];

async function copyDir(src, dest) {
  // Create destination directory
  await fs.mkdir(dest, { recursive: true });

  // Read source directory
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
      console.log(`  Copied: ${entry.name}`);
    }
  }
}

async function main() {
  console.log('Copying WASM builds to extension...\n');

  for (const build of BUILDS) {
    console.log(`[${build.name}]`);

    try {
      // Check if source exists
      await fs.access(build.src);

      // Stash hand-maintained files so the wipe below can't drop them.
      const stashed = {};
      for (const name of build.preserve || []) {
        try {
          stashed[name] = await fs.readFile(path.join(build.dest, name));
        } catch (e) {
          // Not present yet (fresh checkout / already lost) — nothing to stash.
        }
      }

      // Remove existing destination
      try {
        await fs.rm(build.dest, { recursive: true, force: true });
      } catch (e) {
        // Directory may not exist
      }

      // Copy files
      await copyDir(build.src, build.dest);

      // Restore any preserved file the trunk build did not itself provide.
      for (const [name, buf] of Object.entries(stashed)) {
        const p = path.join(build.dest, name);
        try {
          await fs.access(p);
        } catch {
          await fs.writeFile(p, buf);
          console.log(`  Preserved (outside trunk): ${name}`);
        }
      }

      console.log(`  ✓ Copied to ${path.relative(ROOT, build.dest)}\n`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log(`  ⚠ Source not found: ${path.relative(ROOT, build.src)}`);
        console.log(`  Run 'trunk build' in dioxus-ui/${build.name}/ first\n`);
      } else {
        console.error(`  ✗ Error: ${error.message}\n`);
      }
    }
  }

  console.log('Done!');
}

main().catch(console.error);
