# Third-party notices

## jev-ultrafast `snapshot.js` (MIT)

Vendored unmodified at `src/agent/browser/snapshot.upstream.js` from commit 1231850a0b of https://github.com/browser-use/jev-ultrafast (`jev_ultrafast/snapshot.js`).

```
MIT License

Copyright (c) 2026 Browser Use

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Cua Driver 0.28.2 (MIT)

`@trycua/cua-driver` (the TypeScript SDK) and `libcua_driver_sdk.dylib` from `@trycua/cua-driver-darwin-arm64`, source at https://github.com/trycua/cua (tag `cua-driver-rs-v0.28.2`). `scripts/prepare-cua.ts` bundles the SDK into `resources/cua-sdk/cua-sdk.mjs` and stages the dylib, thinned to arm64 and re-signed, in `resources/cua-sdk/native/`.

```
MIT License

Copyright (c) 2025 Cua AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Cua Driver Node runtime (MPL-2.0)

`cua_driver_node_runtime.node` from `@trycua/cua-driver-darwin-arm64` 0.28.2 is derived from the N-API runtime in `uniffi-bindgen-react-native` 0.31.0-3, copyright its contributors, and licensed under the Mozilla Public License 2.0 (https://www.mozilla.org/MPL/2.0/). Its source is the pinned npm dependency plus `scripts/build-node-runtime.mjs` in https://github.com/trycua/cua at tag `cua-driver-rs-v0.28.2`. JevAuto ships it unmodified apart from thinning to arm64 and re-signing.

## `@ubjs/core` and `@ubjs/node` 0.31.0-3 (MPL-2.0)

Bundled unmodified into `resources/cua-sdk/cua-sdk.mjs` by `scripts/prepare-cua.ts`. Licensed under the Mozilla Public License 2.0 (https://www.mozilla.org/MPL/2.0/). Source: https://www.npmjs.com/package/@ubjs/core/v/0.31.0-3 and https://www.npmjs.com/package/@ubjs/node/v/0.31.0-3.
