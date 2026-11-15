#!/bin/sh
# Download the official Gatekeeper circuit artifacts if not already present.
# Source: https://agentgames.zkverify.io/circuits/ (official, public)
set -eu
mkdir -p circuits
cd circuits
if [ ! -s gatekeeper.wasm ]; then
  echo "downloading gatekeeper.wasm ..."
  curl -fsSL -o gatekeeper.wasm https://agentgames.zkverify.io/circuits/gatekeeper.wasm
fi
if [ ! -s gatekeeper_final.zkey ]; then
  echo "downloading gatekeeper_final.zkey ..."
  curl -fsSL -o gatekeeper_final.zkey https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey
fi
ls -la gatekeeper.wasm gatekeeper_final.zkey
