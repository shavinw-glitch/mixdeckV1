# Fonts

## Kosmik — you need to supply this

The UI stack is set to **Kosmik** first:

| | |
|---|---|
| **Typeface** | LTR Kosmik (originally released as **FF Kosmik**) |
| **Designer** | Erik van Blokland |
| **Foundry** | LettError (originally FontFont) |
| **Year** | 1993 |
| **Licence** | **Commercial** — not free, not redistributable |

Kosmik is a commercial typeface, so it is **not bundled in this repository**. The
app is wired to use it the moment the licensed files exist, and silently falls
back to the system UI face (`-apple-system` / `SF Pro Display` / `Segoe UI` /
Inter) until then — so nothing breaks without it.

## Making it active

Drop your licensed files into this folder using these exact names:

```
fonts/
  Kosmik-Regular.woff2   (or .woff or .otf)
  Kosmik-Bold.woff2      (or .woff or .otf)
```

That is all — `@font-face` rules for weights 400 and 700 are already declared in
`index.html`, so the whole app switches over on the next reload.

Don't have it? Buy a licence from LettError Type or Fontstand. If you only need
one weight, supply `Kosmik-Regular` and the bold is synthesised by the browser.

## Where to change the stack

The font stack lives in one place — the `--font-ui` custom property in
`index.html`. Change it there rather than on individual rules.
