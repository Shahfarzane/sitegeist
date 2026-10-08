#!/bin/bash
set -e
# patches/ must match the sibling forks (no-op where the siblings are patched upstream clones)
scripts/sibling-patches.sh check
npm run check
