# YouTube video capture dependencies

Mosaic bundles unmodified Windows x64 releases of yt-dlp and Deno for YouTube video capture. Their exact versions, official download URLs, sizes and SHA-256 checksums are recorded in `runtime.json`.

- yt-dlp source: https://github.com/yt-dlp/yt-dlp/tree/2026.10.26
- yt-dlp official binary: https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26
- Deno source and official binary: https://github.com/denoland/deno/releases/tag/v2.9.8

yt-dlp itself uses the Unlicense; its standalone executable also contains third-party components and the bundled yt-dlp-ejs YouTube JavaScript solver. See `yt-dlp-LICENSE.txt` and `yt-dlp-THIRD_PARTY_LICENSES.txt` for their full license texts. Deno is distributed under the MIT license; see `deno-LICENSE.md` and the source release for third-party acknowledgements.

The application does not enable yt-dlp plugins, load user configuration, read browser cookies or automatically update these executables. Dependency updates are verified and shipped as part of an application update.
