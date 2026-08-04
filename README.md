# ⏳ Time Allocator

A small website that helps you spend your free time the way you *meant* to.

You tell it the things you want to spend your free time on and what percentage
of that time each one should get (e.g. 30% studying, 30% essay, 40% homework).
Then, whenever you have free time and don't know what to do, press
**"What should I do?"** — it looks at what you've actually been doing and picks
the activity that is furthest behind its target, along with a suggested
duration. Follow it through the week and your actual split converges on the
percentages you chose.

## How it works

- **Activities** — add each thing you care about. The first activity gets
  100% of your free time; each new one rebalances everything to equal
  shares. Drag an activity's slider to change its share — the others adjust
  proportionally so the split always totals 100%.
- **Logging** — track free time with the built-in timer (start when you begin,
  stop when you're done) or log sessions manually with quick chips
  (+15m/+30m/+1h/+2h) or a custom number of minutes.
- **Recommendations** — for each activity the site computes its *deficit*:
  `target share × total tracked time − time spent on it`. The activity with
  the biggest deficit is what you should do next. The suggested duration is
  how long it takes for that activity's share to reach its target.
- **Balance view** — a bar per activity shows the share of tracked time it
  actually got, with a tick marking its target, over this week, the last
  7 days, or all time.

All data is stored in your browser's `localStorage` — nothing leaves your
device. You can export/import your data as JSON from the footer.

## Running it

It's a static site with no build step — open `index.html` in a browser, or
serve the folder with any static server.

### GitHub Pages

The repo ships with a GitHub Actions workflow
(`.github/workflows/deploy.yml`) that deploys the site to GitHub Pages on
every push. If the first deployment fails with a Pages permission error, go
to **Settings → Pages** in the repo and set **Source** to **GitHub Actions**,
then re-run the workflow.
