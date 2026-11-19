# Mosaic YouTube connection helper

The desktop download flow uses `--export-browser-session --site youtube|bilibili --output <state-dir>/exports/<UUID>/cookies.txt`. It accepts one bounded JSON object on stdin: `{capturedAt, cookies}` from the current Chrome tab's explicitly granted extension API. Only unpartitioned cookies for the explicitly selected site are accepted; mixed-site payloads are rejected. Bilibili requires a valid nonempty `SESSDATA` cookie. The output file has a private ACL; Node deletes it after the download callback. This command never opens a browser, reads a saved account, or saves the provided session. The older commands below remain YouTube-only for compatibility and tests; desktop connection controls no longer invoke `--connect`.

Adapted from the user's `2026-10-13/bang/work/installer/payload/YouTubeConnection.cs` dedicated Edge connection flow and the same payload's `Source.cs` CurrentUser DPAPI persistence. Existing browser profiles and old session files are never opened.

Build with `powershell -NoProfile -File build.ps1`. Requires Windows .NET Framework 4.x and Google Chrome (preferred) or Microsoft Edge for interactive connection only.

All commands require `--site youtube --state-dir <absolute-local-directory>`:

- `--connect [--url https://www.youtube.com/watch?v=<id>]`: new dedicated Google Chrome login window (Edge only when Chrome is not installed), native Mosaic confirmation prompt, encrypted save after its own browser closes. Startup or login failure does not silently switch browsers.
- `--status`: decrypt and validate its own saved session; reports `connected` only.
- `--export --output <state-dir>/exports/<UUID>/cookies.txt`: current-user-only directory and file, no overwrite.
- `--disconnect`: refuses an active dedicated session; deletes only its own profile and encrypted session.
- `--self-test`: fixed dummy DPAPI/export test in a disposable profile-free subtree; never starts a browser or reads the saved login.

The helper emits one JSON line. It never prints cookie content, paths, CDP endpoints or raw exceptions. Send the line `cancel` to stdin to cancel. The caller must remove export directories after use and allow up to 20 seconds for graceful shutdown before terminating the helper process.

Storage: `youtube-session.dpapi`, separate `youtube-profile-chrome/` and `youtube-profile-edge/`, and `exports/<UUID>/cookies.txt`. The legacy `youtube-profile/` is retained for safe disconnect cleanup, not reused by either browser. The state directory and its contents are restricted to the current Windows user. Native and Node callers should serialize lifecycle operations.
