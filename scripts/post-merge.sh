#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Database migrations are a separate, explicitly approved release step.
# Never infer permission to change production data from a source merge.
