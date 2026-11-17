# Three.js preview runtime

This directory contains the offline runtime for Shitu model previews. No CDN is used.

- Upstream: https://github.com/mrdoob/three.js
- Fixed npm package: `three@0.187.0`
- Archive: https://registry.npmjs.org/three/-/three-0.187.0.tgz
- Upstream package integrity and commit: `origin.json`
- Three.js license: `LICENSE` (MIT)
- Bundled Draco, Basis Universal, meshoptimizer, fflate, ktx-parse and zstddec notices: `THIRD_PARTY_LICENSES.txt`

Only the WebGL build and modules required by the preview are included. Upstream addon imports of the bare `three` package were changed to relative imports of `three.module.js`. The compressed geometry/texture decoder binaries are distributed unchanged from the fixed npm archive. Their workers and WASM modules load from this directory.

`addons/libs/basis/shitu_basis_worker.js` is a fixed worker assembled from the upstream KTX2Loader worker function/constants and the unchanged Basis Universal wrapper. The viewer uses this local worker instead of constructing a blob worker at runtime, keeping Basis' dynamic function construction out of the application's page policy. The original component licenses apply.

Model loaders receive a resource map containing only files in the imported model bundle. The viewer translates model references to authorized `shitu:` URLs. References to the Internet or files outside that map are not fetched.
