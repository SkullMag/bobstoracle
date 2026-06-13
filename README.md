# The Bobst Oracle

A playful random shelf finder for NYU's Elmer Holmes Bobst Library.

The site picks a random Library of Congress call-number section, checks NYU BobCat for real Bobst Main Collection holdings in that section, and sends the visitor to an occupied shelf instead of a specific book.

## Run Locally

```bash
node server.js
```

Then open:

```text
http://localhost:4757
```

## Files

- `index.html` - frontend, styling, animation, modal map viewer, SEO metadata
- `server.js` - local HTTP server and BobCat proxy for random shelf lookup
- `bobst-oracle.service` - systemd unit for running the Node server in production
- `favicon.svg` - site icon
- `robots.txt` - crawler rules
- `sitemap.xml` - sitemap for indexing

## systemd

The included unit assumes the site is deployed to `/home/oleg/bobst` and runs as the `oleg` user.

```bash
sudo cp bobst-oracle.service /etc/systemd/system/bobst-oracle.service
sudo systemctl daemon-reload
sudo systemctl enable --now bobst-oracle
```

Check logs:

```bash
sudo journalctl -u bobst-oracle -f
```

## API

```text
GET /api/shelf
```

Returns a shelf object like:

```json
{
  "floor": "9",
  "cls": "HV",
  "num": 8569,
  "section": "HV 8569",
  "subject": "Social Welfare & Criminology",
  "span": ["HV8569 .A5793 2014", "HV8569 .H4613 1977"],
  "nearby": 3
}
```
