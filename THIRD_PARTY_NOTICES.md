# Third-party notices

The browser console uses [Preact](https://preactjs.com/) through its React compatibility layer. Preact is MIT-licensed, copyright (c) 2015-present Jason Miller. Its full license is shipped as `PREACT-LICENSE.txt` with every console build.

The source uses React's component API and TypeScript types. React and its associated type definitions are MIT-licensed. Development tooling and their licenses are recorded in `package-lock.json`; their packages are installed by `npm ci` and are not copied into the Tower runtime image.

The 3D airport, aircraft, terrain, buildings, vegetation and shaders are authored in this repository. The UI loads Manrope and IBM Plex Mono from Google Fonts; both are distributed under the SIL Open Font License. System fonts are used when those external fonts are unavailable.

The root [MIT license](LICENSE) applies to Clearance's own source. Third-party software and fonts retain their respective licenses.
