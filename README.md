# THE BIG CON


## Building and deploying

The game is a static site (plus a Discord Activity served through Discord's
proxy). `npm run build` turns the repo into a deployable `dist/` folder:

```sh
npm ci --include=dev
npm run build          # writes dist/ (git-ignored); only ever writes inside dist/
npm run build -- --out /some/dir      # or: BUILD_OUT=/some/dir npm run build
npx --yes http-server dist -p 8080 -c-1   # preview it locally
```

What the build does (`scripts/build.mjs`):

1. copies the HTML pages and every asset they use (`static/`, `characters/`, root
   images/favicon) into `dist/` — never `tests/`, `docs/`, `cloudflare-relay/`,
   `node_modules/`, `.github/` or `scripts/`;
2. bundles the Discord Embedded App SDK with esbuild directly into `dist/`;
3. stamps `BUILD_COMMIT` in `dist/index.html` with the first 7 characters of
   `$RENDER_GIT_COMMIT` (set by Render), else `git rev-parse HEAD`, else `dev`;
4. renames every local `.js`/`.css` file to `name.<10-char sha256>.ext` and
   rewrites the references in the HTML pages and in `discord.js`'s dynamic
   `import()` of the SDK bundle. Images are copied unhashed.

### Render settings (static site)

Render's dashboard: the site -> **Settings**.

| Setting | Value |
| --- | --- |
| Build Command | `npm ci --include=dev && npm run build` |
| Publish Directory | `dist` |

(`--include=dev` makes sure esbuild, a devDependency, is installed whatever
`NODE_ENV` is during the build.)

**Settings -> Headers** (add these four rules; Render matches `*` within one path
segment and `**` across directories):

| Path | Header name | Value |
| --- | --- | --- |
| `/` | `Cache-Control` | `no-cache` |
| `/*.html` | `Cache-Control` | `no-cache` |
| `/**/*.js` | `Cache-Control` | `public, max-age=31536000, immutable` |
| `/**/*.css` | `Cache-Control` | `public, max-age=31536000, immutable` |

Every `.js`/`.css` in `dist/` carries a content hash in its file name, so they can
safely be cached forever; HTML must always revalidate so a deploy takes effect at
once. Images are not hashed and keep Render's default caching.

The same configuration lives in [`render.yaml`](render.yaml). The site is
currently dashboard-managed, so that file is **inert unless you adopt it as a
Blueprint** (Dashboard -> New -> Blueprint, pointing at this repo; its service
`name` must match the existing site's name to take it over rather than create a
second site). Do one or the other, not both. Note that a Blueprint sync leaves
existing dashboard headers/routes that are not in the file untouched.

### Tests

```sh
npm ci
node --test tests/*.test.mjs
```

`tests/build.test.mjs` runs the real build into a temp directory.
