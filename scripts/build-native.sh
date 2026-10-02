#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p bin .runtime/swift-module-cache
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun swiftc -parse-as-library -swift-version 6 -O -target arm64-apple-macos26.0 -module-cache-path .runtime/swift-module-cache native/YapLive.swift -o bin/yap-live
