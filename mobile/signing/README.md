# Android signing key

`errs-lab-wall.jks` signs every Android build, so a new version installs over the old one and keeps the wall's data.

- Alias: `errslabwall`
- Store and key password: `786c520e705df365c2f13d74f543e64b`

This key is in a public repository, so anyone could sign an app with it. That is acceptable for an internal display app installed by hand. For stronger protection, add repository secrets `WALL_KEYSTORE_B64` (base64 of a new keystore), `WALL_KEYSTORE_PASSWORD`, `WALL_KEY_ALIAS` and `WALL_KEY_PASSWORD`; the build uses them instead of this file. Changing the key means the app must be uninstalled once (save a backup first).
