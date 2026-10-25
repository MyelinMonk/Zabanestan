# Zabanestan website: GitHub sandbox

A copy of the Zabanestan site that GitHub Pages builds for you. Edit a file on GitHub and the site updates about a minute later. The live Cloudflare site isn't affected.

## Put it online

1. Sign in at github.com and create a new repository (the **+** menu, then **New repository**). Name it something like `zabanestan-sandbox` and make it **Public**: free accounts can only publish Pages sites from public repositories.
2. On the new repository's page, click **uploading an existing file**. Drag in everything inside this folder (the files plus the `_data`, `_includes`, `_layouts` and `fonts` folders), then click **Commit changes**.
3. Open **Settings**, then **Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, pick **main** and **/ (root)**, and click **Save**.
4. After a minute or two the site is live at `https://YOUR-USERNAME.github.io/zabanestan-sandbox/`. The **Actions** tab shows each build.

Anyone can see everything in a public repository, including its edit history. Keep consent records and private submissions out of it.

## Where things live

| To change | Edit |
|---|---|
| Email, Discord invite, consent form link, dates | `_config.yml` |
| The language roster | `_data/languages.yml` |
| Links on the Resources page | `_data/resources.yml` |
| The top menu | `_data/navigation.yml` |
| About page text | `about.md` |
| Home, Languages, Resources and Get involved pages | `index.html`, `languages.html`, `resources.html`, `get-involved.html` |
| Header and footer on every page | `_includes/header.html`, `_includes/footer.html` |
| Colors, fonts and layout | `styles.css` (the color settings come right after the font list) |

To edit on GitHub, open a file, click the pencil icon, make your change and click **Commit changes**.

## Tips

- **The roster's order is its ranking.** The site groups languages by endangerment level and numbers them automatically, and counts like "20 languages" update themselves. The notes at the top of `_data/languages.yml` explain each field.
- **About page formatting:** `##` starts a section, `-` starts a bullet, `**text**` is bold and `[text](address)` is a link. The "On this page" list builds itself from the `##` headings.
- **YAML files** (`_config.yml` and everything in `_data`): indent with two spaces, never tabs, and keep text in double quotes.
- **If a change doesn't appear,** check the Actions tab. A red mark means the build failed and the previous version is still live; the log names the file and line. Fix it and commit again.
- **If the "page not found" page looks unstyled,** add `baseurl: /zabanestan-sandbox` (your repository's name) to `_config.yml`. The other pages don't need this.

## Search engines

This copy asks search engines not to list it, so it won't compete with the real site. To change that, set `hide_from_search_engines` to `false` in `_config.yml`.

## Preview on your own computer (optional)

Install Ruby, then run `bundle install` and `bundle exec jekyll serve` in this folder and open http://localhost:4000.
